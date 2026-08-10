import sqlite3, os, json, shutil, time

APPDATA = os.environ['APPDATA']
db = os.path.join(APPDATA, r'Code\User\globalStorage\state.vscdb')

# backup the db (and WAL/SHM if present)
stamp = time.strftime('%Y%m%d-%H%M%S')
for suffix in ('', '-wal', '-shm'):
    src = db + suffix
    if os.path.exists(src):
        shutil.copy2(src, db + '.bak-nika-' + stamp + suffix)
print('backup done:', db + '.bak-nika-' + stamp)

pairs = [
    ('secret://{"extensionId":"nikas.nikas","key":"nikas.deepseek.apiKey"}',
     'secret://{"extensionId":"nika.nika","key":"nika.deepseek.apiKey"}'),
    ('secret://{"extensionId":"nikas.nikas","key":"nikas.gemini.apiKey"}',
     'secret://{"extensionId":"nika.nika","key":"nika.gemini.apiKey"}'),
]

con = sqlite3.connect(db, timeout=30)
con.execute('PRAGMA busy_timeout=30000')
cur = con.cursor()

for src_key, dst_key in pairs:
    cur.execute('SELECT value FROM ItemTable WHERE key=?', (src_key,))
    row = cur.fetchone()
    if not row or row[0] is None:
        print('SOURCE MISSING:', src_key)
        continue
    blob = row[0]
    cur.execute('SELECT value FROM ItemTable WHERE key=?', (dst_key,))
    old = cur.fetchone()
    cur.execute(
        'INSERT INTO ItemTable (key, value) VALUES (?, ?) '
        'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        (dst_key, blob))
    # verify
    cur.execute('SELECT value FROM ItemTable WHERE key=?', (dst_key,))
    new = cur.fetchone()
    ok = new is not None and new[0] == blob
    same_as_before = old is not None and old[0] == blob
    print(('OK   ' if ok else 'FAIL ') + dst_key + (' (was already identical)' if same_as_before else ' (updated)'))
    if not ok:
        print('  source len:', len(blob), 'new len:', len(new[0]) if new else None)

con.commit()
con.close()
print('done')
