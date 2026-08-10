import sqlite3, os, json

db = os.path.join(os.environ['APPDATA'], r'Code\User\globalStorage\state.vscdb')
con = sqlite3.connect(db)
cur = con.cursor()
cur.execute('SELECT value FROM ItemTable WHERE key=?', ('secret://{"extensionId":"nikas.nikas","key":"nikas.deepseek.apiKey"}',))
row = cur.fetchone()
v = bytes(json.loads(row[0])['data'])
print('total bytes:', len(v))
print('first 64 bytes hex:', v[:64].hex(' '))
print('first 3 bytes ascii:', bytes(v[:3]))
# DPAPI blob magic check
expected = bytes([0x01, 0x00, 0x00, 0x00, 0xD0, 0x8C, 0x9D, 0xDF, 0x01, 0x15, 0xD1, 0x11, 0x8C, 0x7A, 0x00, 0xC0, 0x4F, 0xC2, 0x97, 0xEB])
print('DPAPI magic at offset 3:', bytes(v[3:23]) == expected)
print('magic actual:', bytes(v[3:23]).hex(' '))
