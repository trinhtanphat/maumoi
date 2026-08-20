import sqlite3
from pathlib import Path

sql = Path('migrations/0001_initial.sql').read_text()
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
db.executescript(sql)
now = '2026-08-20T08:00:00.000Z'
db.execute("INSERT INTO admins VALUES(?,?,?,?,?,?,?)", ('a1','admin@example.test','hash','Admin','ACTIVE',now,now))
db.execute("INSERT INTO collaborators VALUES(?,?,?,?,?,?,?,?,?,?)", ('c1','CTV001','CTV 1','84912345678',None,'HCM','A','ACTIVE',now,now))
db.execute("INSERT INTO sample_products VALUES(?,?,?,?,?,?,?)", ('p1','SKU1','Mau 1','CMP1','ACTIVE',now,now))
db.execute("INSERT INTO inventory_allocations VALUES(?,?,?,?,?,?,?,?)", ('al1','c1','p1',2,now,'a1','smoke','ACTIVE'))
db.execute("INSERT INTO customers VALUES(?,?,?,?,?,?)", ('u1','Khach 1','84987654321','849****4321','c1',now))
db.execute("INSERT INTO otp_challenges VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ('o1','84987654321','c1','CMP1','dev',None,'hash',0,'2026-08-20T09:00:00.000Z','2026-08-20T08:01:00.000Z',None,now))
db.execute("INSERT INTO evidence_objects VALUES(?,?,?,?,?,?,?,?,?,?)", ('e1','evidence/e1','sha','image/jpeg',100,now,None,None,'PENDING','c1'))
db.execute("INSERT INTO sample_distributions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", ('d1','c1','u1','p1','CMP1','84987654321',1,'o1','e1','2026-08-20T08:02:00.000Z','COMPLETED','idem-00000001','fp1'))
assert db.execute("SELECT consumed_at FROM otp_challenges WHERE id='o1'").fetchone()[0] is not None
assert db.execute("SELECT status FROM evidence_objects WHERE id='e1'").fetchone()[0] == 'FINALIZED'

# Duplicate campaign claim must fail even with another customer id.
db.execute("INSERT INTO otp_challenges VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ('o2','84987654321','c1','CMP1','dev',None,'hash',0,'2026-08-20T09:00:00.000Z','2026-08-20T08:03:00.000Z',None,now))
db.execute("INSERT INTO evidence_objects VALUES(?,?,?,?,?,?,?,?,?,?)", ('e2','evidence/e2','sha2','image/jpeg',100,now,None,None,'PENDING','c1'))
try:
    db.execute("INSERT INTO sample_distributions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", ('d2','c1','u1','p1','CMP1','84987654321',1,'o2','e2','2026-08-20T08:04:00.000Z','COMPLETED','idem-00000002','fp2'))
    raise AssertionError('duplicate campaign claim unexpectedly succeeded')
except sqlite3.IntegrityError:
    pass

# Remaining stock is 1; quantity 2 must fail in trigger.
db.execute("INSERT INTO customers VALUES(?,?,?,?,?,?)", ('u2','Khach 2','84911111111','849****1111','c1',now))
db.execute("INSERT INTO otp_challenges VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ('o3','84911111111','c1','CMP1','dev',None,'hash',0,'2026-08-20T09:00:00.000Z','2026-08-20T08:05:00.000Z',None,now))
db.execute("INSERT INTO evidence_objects VALUES(?,?,?,?,?,?,?,?,?,?)", ('e3','evidence/e3','sha3','image/jpeg',100,now,None,None,'PENDING','c1'))
try:
    db.execute("INSERT INTO sample_distributions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", ('d3','c1','u2','p1','CMP1','84911111111',2,'o3','e3','2026-08-20T08:06:00.000Z','COMPLETED','idem-00000003','fp3'))
    raise AssertionError('insufficient stock unexpectedly succeeded')
except sqlite3.IntegrityError as e:
    assert 'INSUFFICIENT_STOCK' in str(e)

print('D1 schema smoke OK: constraints + triggers enforced')
