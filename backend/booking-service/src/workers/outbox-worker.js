import amqp from 'amqplib';
import pg from 'pg';
const connectionString = process.env.OUTBOX_SOURCE === 'member'
  ? process.env.MEMBER_DATABASE_URL : process.env.BOOKING_DATABASE_URL;
const pool = new pg.Pool({ connectionString });
const url = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  let connection, channel;
  while (!channel) {
    try { connection=await amqp.connect(url); const readyChannel=await connection.createConfirmChannel(); await readyChannel.assertQueue('vitality.audit.events',{durable:true}); channel=readyChannel; }
    catch(e){ if (connection) await connection.close().catch(() => {}); console.error('RabbitMQ unavailable; retrying:',e.message); await sleep(3000); }
  }
  console.log('Outbox worker connected; publishing pending audit events');
  connection.on('close',()=>{console.error('RabbitMQ connection closed; worker will exit for container restart');process.exit(1);});
  while(true){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const result=await client.query("SELECT id,event_id,event_type,payload FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED");
      for(const event of result.rows){
        channel.sendToQueue('vitality.audit.events',Buffer.from(JSON.stringify(event.payload)),{persistent:true,messageId:event.event_id,type:event.event_type});
        await channel.waitForConfirms();
        await client.query('UPDATE outbox_events SET published_at=now() WHERE id=$1',[event.id]);
      }
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');console.error('Outbox publish failed; retrying:',e.message);}
    finally{client.release();}
    await sleep(1000);
  }
}
run().catch(e=>{console.error(e);process.exit(1);});
