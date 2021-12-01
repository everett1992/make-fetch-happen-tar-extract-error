import crypto from 'crypto'
import fetch from 'make-fetch-happen'
import tar from 'tar'
import fs from 'fs/promises'
import http from 'http'
import t from 'tap'
import ssri from 'ssri'

const lodash = await fs.readFile('lodash-4.17.19.tgz')
const integrity = ssri.fromData(lodash)

// different sizes will reproduce the issue, but large sizes will not.
const size = 0x4000

const server = http.createServer(async (req, res) => {
  const headers = {}
  if (req.url === '/content-length') headers['content-length'] = lodash.length
  res.writeHead(200, headers)
  for (let i = 0; i < lodash.length; i += size) {
    res.write(lodash.slice(i, i+size));
  }
  res.end()
})

server.listen(4000, 'localhost')
await new Promise((resolve, reject) => {
  server.once('listening', resolve)
  server.once('error', reject)
})
console.log(server.address())
t.teardown(() => server.close())

await t.test('res.body data events updating hash', async t => {
  const res = await fetch('http://localhost:4000', { integrity })
  const hash = crypto.createHash('sha512')
  await new Promise((resolve,reject) => {
    res.body.on('end', resolve)
    res.body.on('error', reject)
    res.body.on('data', data => hash.update(data))
  })

  t.equal(hash.digest('hex'), integrity.hexDigest(), 'yields the right digest')
})

await t.test('res.body pipe to createHash', async t => {
  const res = await fetch('http://localhost:4000', { integrity })
  const hash = crypto.createHash('sha512')
  await new Promise((resolve,reject) => {
    // XXX Hash doesn't emit end?
    // hash.on('end', resolve)
    res.body.on('end', resolve)
    hash.on('error', reject)
    res.body.on('error', reject)
    res.body.pipe(hash)
  })

  t.equal(hash.digest('hex'), integrity.hexDigest(), 'yields the right digest')
})

await t.test('extract with integrity', async t => {
  // this test fails, demoing how make-fetch-happen, chunked-encoding, and tar
  // extract don't work together.
  const dest = t.testdir()
  const res = await fetch('http://localhost:4000', { integrity })
  await extract(res.body, dest)
  t.pass('succeeds')
})

await t.test('extract affects source stream?', async t => {
  // this test also fails, but this time we pipe res.body to a ssri stream, and
  // ssri to extract. Here the integrity is not expected, implying tar extract
  // affects it's source?
  const dest = t.testdir()
  const res = await fetch('http://localhost:4000', { integrity })
  const istream = res.body.pipe(ssri.integrityStream())

  let size, hash
  istream.on('integrity', i => hash = i)
  istream.on('size', s => size = s)

  await Promise.allSettled([extract(istream, dest)])

  // why would the istream, the _input_of_tar.x_ emit an unexpected integrity?
  // why is size expected but hash is wrong? data emitted out of order?
  t.equal(hash.hexDigest(), integrity.hexDigest(), 'source hash is expected')
  t.equal(size, lodash.length, 'source size is expected')
})

await t.test('extract with integrity and content-length', async t => {
  const dest = t.testdir()
  const res = await fetch('http://localhost:4000/content-length', { integrity })

  await extract(res.body, dest)
  t.pass('succeeds')
})

await t.test('extract without integrity', async t => {
  const dest = t.testdir()
  const res = await fetch('http://localhost:4000')

  await extract(res.body, dest)
  t.pass('succeeds')
})

async function extract (stream, dest) {
  // copied from pacote
  // https://github.com/npm/pacote/blob/bd67be1ea53ab02c2be781a3fc2283eb9fcba3c8/lib/fetcher.js#L399-L419
  const extractor = tar.x({ cwd: dest })
  return new Promise((resolve, reject) => {
    extractor.on('end', resolve)
    extractor.on('error', reject)
    stream.on('error', reject)
    stream.pipe(extractor)
  })
}
