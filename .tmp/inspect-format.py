import sqlite3, os, json

db = os.path.join(os.environ['APPDATA'], r'Code\User\globalStorage\state.vscdb')
con = sqlite3.connect(db)
cur = con.cursor()
keys = {
    'nikas.deepseek': 'secret://{"extensionId":"nikas.nikas","key":"nikas.deepseek.apiKey"}',
    'nika.deepseek': 'secret://{"extensionId":"nika.nika","key":"nika.deepseek.apiKey"}',
}
for name, sk in keys.items():
    cur.execute('SELECT value FROM ItemTable WHERE key=?', (sk,))
    row = cur.fetchone()
    v = row[0] if row and row[0] is not None else None
    if v is None:
        print(name, '-> MISSING')
        continue
    print(name, '-> type:', type(v).__name__, 'len:', len(v))
    s = v if isinstance(v, str) else v.decode('utf-8', 'replace')
    print('  prefix:', repr(s[:60]))
    try:
        parsed = json.loads(s)
        print('  is JSON:', True, 'keys:', list(parsed.keys()))
    except Exception as e:
        print('  is JSON:', False)
