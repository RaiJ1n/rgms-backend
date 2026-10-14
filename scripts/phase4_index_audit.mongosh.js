// READ-ONLY audit for Phase 4. Changes nothing.
// Run:  mongosh "<your connection string>" --quiet phase4_index_audit.mongosh.js
// (Do NOT paste the connection string, or this output if it contains secrets, into chat.)
print('--- server ---');
printjson({ version: db.version(), replicaSet: (db.hello().setName || null), isWritablePrimary: db.hello().isWritablePrimary });

for (const c of ['attendances', 'rfidcards', 'subscriptions', 'tempcardassignments']) {
  print(`\n--- ${c}.getIndexes() ---`);
  try { printjson(db.getCollection(c).getIndexes()); } catch (e) { print('  (collection missing) ' + e.message); }
}

print('\n--- members with 2+ OPEN sessions flagged openSession:true (must be 0) ---');
printjson(db.attendances.aggregate([
  { $match: { openSession: true } }, { $group: { _id: '$userId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray());

print('\n--- duplicate requestId / checkOutRequestId (must be 0) ---');
printjson(db.attendances.aggregate([{ $match: { requestId: { $type: 'string' } } }, { $group: { _id: '$requestId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray());
printjson(db.attendances.aggregate([{ $match: { checkOutRequestId: { $type: 'string' } } }, { $group: { _id: '$checkOutRequestId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray());

print('\n--- members with several sessions on one dayKey (proves multi-session already works if > 0) ---');
printjson(db.attendances.aggregate([
  { $match: { userId: { $type: 'objectId' }, dayKey: { $type: 'string' } } },
  { $group: { _id: { u: '$userId', d: '$dayKey' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 5 }]).toArray());

print('\n--- subscriptions with sessionsUsed > day span (needs MongoDB 5.0+; skip if it errors) ---');
printjson(db.subscriptions.aggregate([
  { $addFields: { days: { $dateDiff: { startDate: '$startDate', endDate: '$endDate', unit: 'day' } } } },
  { $match: { $expr: { $gt: ['$sessionsUsed', '$days'] } } },
  { $project: { _id: 0, userId: 1, sessionsUsed: 1, days: 1 } }, { $limit: 5 }]).toArray());