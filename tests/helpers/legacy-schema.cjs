'use strict';

// Real schema-2 preference constraints, for disposable migration/restore fixtures.
// Do not simply change user_version on a schema-3 database: that would not test
// replacing the older CHECK constraint.
function makeSchema2(database) {
  database.transaction(() => {
    database.exec(`ALTER TABLE preferences RENAME TO current_preferences;
      CREATE TABLE preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        appearance INTEGER NOT NULL CHECK (appearance BETWEEN 0 AND 100),
        layout TEXT NOT NULL CHECK (layout IN ('continuous', 'tabs')),
        directory_view TEXT NOT NULL CHECK (directory_view IN ('grid', 'list')),
        sort TEXT NOT NULL,
        palette TEXT NOT NULL DEFAULT 'sage'
          CHECK (palette IN ('sage', 'ocean', 'lavender', 'terracotta', 'rose', 'graphite'))
      );
      INSERT INTO preferences (id, appearance, layout, directory_view, sort, palette)
        SELECT id, appearance, layout, directory_view, sort, palette FROM current_preferences;
      DROP TABLE current_preferences;`);
    database.pragma('user_version = 2');
  })();
}

module.exports = { makeSchema2 };
