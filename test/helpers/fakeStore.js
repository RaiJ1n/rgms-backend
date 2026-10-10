// Tiny in-memory stand-in for Mongoose models, shared by the newer tests.
// Supports the query/update operators these code paths use and lets a test
// declare the unique indexes the real schema has (via `uniqueCheck`). It
// verifies application logic; it does NOT prove real MongoDB behaviour.
let seq = 0;
const nid = () => `a${String(++seq).padStart(23, '0')}`;
const idv = (v) => String(v && v._id ? v._id : v);
const same = (a, b) => idv(a) === idv(b);
const isNil = (v) => v === null || v === undefined;

function matchValue(actual, cond) {
  if (cond === null) return isNil(actual);
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof RegExp)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$ne': return v === null ? !isNil(actual) : !same(actual, v);
        case '$in': return v.some((x) => same(actual, x));
        case '$exists': return v ? actual !== undefined : actual === undefined;
        case '$lt': return actual != null && actual < v;
        case '$lte': return actual != null && actual <= v;
        case '$gt': return actual != null && actual > v;
        case '$gte': return actual != null && actual >= v;
        case '$regex': return new RegExp(v, cond.$options || '').test(String(actual));
        case '$options': return true;
        default: throw new Error(`fake store: unsupported operator ${op}`);
      }
    });
  }
  return cond instanceof Date ? +actual === +cond : same(actual, cond);
}
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    return matchValue(doc[k], cond);
  });
}
function applyUpdate(doc, update) {
  Object.entries(update.$set || {}).forEach(([k, v]) => { doc[k] = v; });
  Object.keys(update.$unset || {}).forEach((k) => { delete doc[k]; });
}
const dup = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });

function install(Model, store, defaults = {}, uniqueCheck = () => {}) {
  const wrap = (d) => (d ? Object.assign(d, {
    toObject() { const { toObject, populate, save, ...rest } = this; return { ...rest }; },
    async populate() { return this; },
    async save() { return this; },
  }) : d);
  const query = (fn) => ({
    _sort: null,
    limit() { return this; }, select() { return this; }, lean() { return this; }, populate() { return this; },
    sort(s) { this._sort = s; return this; },
    then(res, rej) { return Promise.resolve(fn(this._sort)).then(res, rej); },
  });
  const sorted = (rows, sort) => {
    if (!sort) return rows;
    const [k, dir] = Object.entries(sort)[0];
    return [...rows].sort((a, b) => ((a[k] > b[k]) - (a[k] < b[k])) * dir);
  };
  Model.create = async (data) => {
    // yield once so concurrent callers genuinely interleave around the write
    await Promise.resolve();
    const d = wrap({ _id: nid(), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...data });
    uniqueCheck(d, store);
    store.push(d);
    return d;
  };
  Model.findOne = (f) => query((s) => wrap(sorted(store.filter((d) => matches(d, f)), s)[0] || null));
  Model.find = (f = {}) => query((s) => sorted(store.filter((d) => matches(d, f)), s));
  Model.findById = (id) => query(() => wrap(store.find((d) => same(d._id, id)) || null));
  Model.findOneAndUpdate = async (f, u) => {
    await Promise.resolve();
    const d = store.find((x) => matches(x, f));
    if (!d) return null;
    applyUpdate(d, u);
    return wrap(d);
  };
  Model.updateOne = async (f, u) => { const d = store.find((x) => matches(x, f)); if (d) applyUpdate(d, u); return { modifiedCount: d ? 1 : 0 }; };
  Model.updateMany = async (f, u) => { const rows = store.filter((x) => matches(x, f)); rows.forEach((d) => applyUpdate(d, u)); return { modifiedCount: rows.length }; };
  Model.countDocuments = async (f = {}) => store.filter((d) => matches(d, f)).length;
}

module.exports = { install, dup, nid, same, matches };
