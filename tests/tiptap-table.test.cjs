const assert = require('node:assert/strict');
const test = require('node:test');

test('Tiptap TableKit round-trips a table inserted by the editor toolbar command', async () => {
  const [{ Editor }, { default: StarterKit }, { TableKit }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/starter-kit'),
    import('@tiptap/extension-table'),
  ]);
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TableKit.configure({ table: { resizable: true } }),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  assert.equal(editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true }), true);
  const table = editor.getJSON().content?.[0];
  assert.equal(table?.type, 'table');
  assert.equal(table?.content?.length, 3);
  editor.destroy();
});
