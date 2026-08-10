import sqlite3, os, json

db = os.path.join(os.environ['APPDATA'], r'Code\User\globalStorage\state.vscdb')
con = sqlite3.connect(db)
cur = con.cursor()
keys = {
    'nikas.deepseek': 'secret://{"extensionId":"nikas.nikas","key":"nikas.deepseek.apiKey"}',
    'nikas.gemini': 'secret://{"extensionId":"nikas.nikas","key":"nikas.gemini.apiKey"}',
    'nika.deepseek': 'secret://{"extensionId":"nika.nika","key":"nika.deepseek.apiKey"}',
    'nika.gemini': 'secret://{"extensionId":"nika.nika","key":"nika.gemini.apiKey"}',
}
out = {}
for name, sk in keys.items():
    cur.execute('SELECT value FROM ItemTable WHERE key=?', (sk,))
    row = cur.fetchone()
    out[name] = row[0] if row and row[0] is not None else None
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'secret-blobs.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f)
print('written')
