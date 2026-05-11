const { postgresDb } = require('./apps/api/src/services/postgres');
postgresDb.from('quests').select('id, slug, ends_at').then(res => console.log(JSON.stringify(res, null, 2)));
