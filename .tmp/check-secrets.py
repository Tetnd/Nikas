import sqlite3, os, hashlib

db = os.path.join(os.environ['APPDATA'], r'Code\User\globalStorage\state.vscdb')
con = sqlite3.connect(db)
cur = con.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
print('TABLES:', [r[0] for r in cur.fetchall()])

keys_of_interest = [
    'nikas.deepseek.apiKey',
    'nikas.gemini.apiKey',
    'nika.deepseek.apiKey',
    'nika.gemini.apiKey',
]

cur.execute('PRAGMA table_info(ItemTable)')
print('ItemTable schema:', cur.fetchall())
cur.execute("SELECT key FROM ItemTable WHERE key LIKE '%nika%' OR key LIKE '%deepseek%' OR key LIKE '%gemini%' OR key LIKE '%apiKey%'")
items = cur.fetchall()
print('MATCHING ITEM KEYS:')
for r in items:
    print('  ', r[0])

# look for any table that could hold secrets
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
for t in tables:
    cur.execute('PRAGMA table_info(' + t + ')')
    cols = [c[1] for c in cur.fetchall()]
    if 'value' in cols or 'secret' in cols:
        print('POSSIBLE SECRET TABLE:', t, cols)

# blob comparison for the four keys of interest (hashes only, never values)
blobs = {}
storage_keys = {
    'nikas.deepseek.apiKey': 'secret://{"extensionId":"nikas.nikas","key":"nikas.deepseek.apiKey"}',
    'nikas.gemini.apiKey': 'secret://{"extensionId":"nikas.nikas","key":"nikas.gemini.apiKey"}',
    'nika.deepseek.apiKey': 'secret://{"extensionId":"nika.nika","key":"nika.deepseek.apiKey"}',
    'nika.gemini.apiKey': 'secret://{"extensionId":"nika.nika","key":"nika.gemini.apiKey"}',
}
for k in keys_of_interest:
    cur.execute('SELECT value FROM ItemTable WHERE key=?', (storage_keys[k],))
    row = cur.fetchone()
    print('LOOKUP', k, '->', ('FOUND len=' + str(len(row[0])) if row and row[0] is not None else 'NOT FOUND'))
    if row and row[0] is not None:
        blobs[k] = row[0]

print('BLOB HASHES (sha256 prefix, NOT the secret):')
for k, v in blobs.items():
    print('  ', k, '->', hashlib.sha256(v).hexdigest()[:16])

if 'nikas.deepseek.apiKey' in blobs and 'nika.deepseek.apiKey' in blobs:
    same = blobs['nikas.deepseek.apiKey'] == blobs['nika.deepseek.apiKey']
    print('DEEPSEEK blobs identical:', same)
if 'nikas.gemini.apiKey' in blobs and 'nika.gemini.apiKey' in blobs:
    same = blobs['nikas.gemini.apiKey'] == blobs['nika.gemini.apiKey']
    print('GEMINI blobs identical:', same)
