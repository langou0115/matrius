import { loadSettings } from '../config';
import { AppDatabase } from '../db/client';
import { migrate, schemaStatus } from '../db/migrate';

const settings = loadSettings();
const db = new AppDatabase(settings.databasePath);
try {
  const result = migrate(db);
  console.log(JSON.stringify({
    database: settings.databasePath,
    ...result,
    status: schemaStatus(db),
  }, null, 2));
} finally {
  db.close();
}
