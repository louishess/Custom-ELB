'use strict';
const path = require('node:path');
const {LibraryStore} = require('../../electron/backend/store.cjs');
const {createBackupService} = require('../../electron/backend/backup.cjs');
const [root, archive, phase] = process.argv.slice(2);
const store = new LibraryStore(root);
createBackupService(store,{onSwitchPhase:current=>{if(current===phase) process.exit(73);}}).restore({source:path.resolve(archive),password:'disposable-test-password'}).then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
