param(
  [string]$Container = "postgres",
  [string]$AdminUser = "postgres",
  [string]$AdminDatabase = "postgres"
)
$ErrorActionPreference = "Stop"
Write-Host "Creating Vitality databases inside existing container '$Container'..."
# CREATE DATABASE cannot run inside a transaction. The script is safe to re-run.
$create = @"
SELECT 'CREATE DATABASE vitality_members' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='vitality_members')\gexec
SELECT 'CREATE DATABASE vitality_bookings' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='vitality_bookings')\gexec
"@
$create | docker exec -i $Container psql -U $AdminUser -d $AdminDatabase
if ($LASTEXITCODE -ne 0) { throw "Could not create databases. Check container name, admin user and credentials." }
Get-Content "backend/database/member-schema.sql" | docker exec -i $Container psql -v ON_ERROR_STOP=1 -U $AdminUser -d vitality_members
if ($LASTEXITCODE -ne 0) { throw "Member schema initialization failed." }
Get-Content "backend/database/booking-schema.sql" | docker exec -i $Container psql -v ON_ERROR_STOP=1 -U $AdminUser -d vitality_bookings
if ($LASTEXITCODE -ne 0) { throw "Booking schema initialization failed." }
Write-Host "Vitality databases and tables are ready." -ForegroundColor Green
