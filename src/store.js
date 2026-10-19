import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export class Store {
 constructor(directory){fs.mkdirSync(directory,{recursive:true});this.db=new DatabaseSync(path.join(directory,'companion.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');}
 read(key){const row=this.db.prepare('SELECT value FROM state WHERE key=?').get(key);return row?JSON.parse(row.value):null;}
 write(key,value){this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
}
