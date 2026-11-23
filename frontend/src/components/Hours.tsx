import { motion } from "framer-motion";
import { Clock } from "lucide-react";

const Hours = () => {
  return (
    <section id="hours" className="py-24 bg-background">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="font-display text-5xl md:text-7xl gradient-text mb-6">
            OPENING HOURS
          </h2>
          <p className="max-w-2xl mx-auto text-muted-foreground text-lg">
            We're here when you need us. Train on your schedule.
          </p>
        </motion.div>

        <div className="max-w-2xl mx-auto">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="card-gradient rounded-3xl p-8 md:p-12 border border-border"
          >
            <div className="flex justify-center mb-8">
              {/* <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center animate-pulse-glow"> */}
                <Clock className="w-10 h-10 text-primary" />
              {/* </div> */}
            </div>

            <div className="space-y-6">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: 0.1 }}
                className="flex justify-between items-center py-4 border-b border-border"
              >
                <span className="font-display text-2xl text-foreground">
                  Monday - Friday
                </span>
                <span className="text-xl text-primary font-medium">
                  7:30 AM - 10:00 PM
                </span>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: 0.2 }}
                className="flex justify-between items-center py-4 border-b border-border"
              >
                <span className="font-display text-2xl text-foreground">
                  Saturday
                </span>
                <span className="text-xl text-primary font-medium">
                  7:30 AM - 2:00 PM
                </span>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: 0.3 }}
                className="flex justify-between items-center py-4"
              >
                <span className="font-display text-2xl text-foreground">
                  Sunday
                </span>
                <span className="text-xl text-primary font-medium">Closed</span>
              </motion.div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default Hours;
