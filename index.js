var ethUtil = require('ethereumjs-util')
var crypto = require('crypto')
var scryptsy = require('scrypt.js')
var uuid = require('uuid')
var utf8 = require('utf8')
var aesjs = require('aes-js')

function assert (val, msg) {
  if (!val) {
    throw new Error(msg || 'Assertion failed')
  }
}

function decipherBuffer (decipher, data) {
  return Buffer.concat([ decipher.update(data), decipher.final() ])
}

var Wallet = function (priv) {
  this.privKey = priv
}

Wallet.generate = function (icapDirect) {
  if (icapDirect) {
    while (true) {
      var privKey = crypto.randomBytes(32)
      if (ethUtil.privateToAddress(privKey)[0] === 0) {
        return new Wallet(privKey)
      }
    }
  } else {
    return new Wallet(crypto.randomBytes(32))
  }
}

Wallet.prototype.getPrivateKey = function () {
  return this.privKey
}

Wallet.prototype.getPrivateKeyString = function () {
  return '0x' + this.getPrivateKey().toString('hex')
}

Wallet.prototype.getPublicKey = function () {
  return ethUtil.privateToPublic(this.privKey)
}

Wallet.prototype.getPublicKeyString = function () {
  return '0x' + this.getPublicKey().toString('hex')
}

Wallet.prototype.getAddress = function () {
  return ethUtil.privateToAddress(this.privKey)
}

Wallet.prototype.getAddressString = function () {
  return '0x' + this.getAddress().toString('hex')
}

Wallet.prototype.getChecksumAddressString = function () {
  return ethUtil.toChecksumAddress(this.getAddressString())
}

// https://github.com/ethereum/wiki/wiki/Web3-Secret-Storage-Definition
Wallet.prototype.toV3 = function (password, opts) {
  opts = opts || {}
  var salt = opts.salt || crypto.randomBytes(32)
  var iv = opts.iv || crypto.randomBytes(16)

  var derivedKey
  var kdf = opts.kdf || 'scrypt'
  var kdfparams = {
    dklen: opts.dklen || 32,
    salt: salt.toString('hex')
  }

  if (kdf === 'pbkdf2') {
    kdfparams.c = opts.c || 262144
    kdfparams.prf = 'hmac-sha256'
    derivedKey = crypto.pbkdf2Sync(new Buffer(password), salt, kdfparams.c, kdfparams.dklen, 'sha256')
  } else if (kdf === 'scrypt') {
    // FIXME: support progress reporting callback
    kdfparams.n = opts.n || 262144
    kdfparams.r = opts.r || 8
    kdfparams.p = opts.p || 1
    derivedKey = scryptsy(new Buffer(password), salt, kdfparams.n, kdfparams.r, kdfparams.p, kdfparams.dklen)
  } else {
    throw new Error('Unsupported kdf')
  }

  var cipher = crypto.createCipheriv(opts.cipher || 'aes-128-ctr', derivedKey.slice(0, 16), iv)
  if (!cipher) {
    throw new Error('Unsupported cipher')
  }

  var ciphertext = Buffer.concat([ cipher.update(this.privKey), cipher.final() ])

  var mac = ethUtil.sha3(Buffer.concat([ derivedKey.slice(16, 32), new Buffer(ciphertext, 'hex') ]))

  return {
    version: 3,
    id: uuid.v4({ random: opts.uuid || crypto.randomBytes(16) }),
    address: this.getAddress().toString('hex'),
    Crypto: {
      ciphertext: ciphertext.toString('hex'),
      cipherparams: {
        iv: iv.toString('hex')
      },
      cipher: opts.cipher || 'aes-128-ctr',
      kdf: kdf,
      kdfparams: kdfparams,
      mac: mac.toString('hex')
    }
  }
}

Wallet.prototype.toV3String = function (password, opts) {
  return JSON.stringify(this.toV3(password, opts))
}

Wallet.fromPrivateKey = function (priv) {
  return new Wallet(priv)
}

// https://github.com/ethereum/go-ethereum/wiki/Passphrase-protected-key-store-spec
Wallet.fromV1 = function (input, password) {
  var json = (typeof input === 'object') ? input : JSON.parse(input)

  if (json.Version !== '1') {
    throw new Error('Not a V1 wallet')
  }

  if (json.Crypto.KeyHeader.Kdf !== 'scrypt') {
    throw new Error('Unsupported key derivation scheme')
  }

  var kdfparams = json.Crypto.KeyHeader.KdfParams
  var derivedKey = scryptsy(new Buffer(password), new Buffer(json.Crypto.Salt, 'hex'), kdfparams.N, kdfparams.R, kdfparams.P, kdfparams.DkLen)

  var ciphertext = new Buffer(json.Crypto.CipherText, 'hex')

  var mac = ethUtil.sha3(Buffer.concat([ derivedKey.slice(16, 32), ciphertext ]))
  console.log(mac, json.Crypto.MAC)

  if (mac.toString('hex') !== json.Crypto.MAC) {
    throw new Error('Key derivation failed - possibly wrong passphrase')
  }

  var decipher = crypto.createDecipheriv('aes-128-cbc', ethUtil.sha3(derivedKey.slice(0, 16)).slice(0, 16), new Buffer(json.Crypto.IV, 'hex'))
  var seed = decipherBuffer(decipher, ciphertext)

  // FIXME: Remove PKCS#7 padding here?

  return new Wallet(seed)
}

Wallet.fromV3 = function (input, password) {
  var json = (typeof input === 'object') ? input : JSON.parse(input)

  if (json.version !== 3) {
    throw new Error('Not a V3 wallet')
  }

  var derivedKey
  var kdfparams
  if (json.Crypto.kdf === 'scrypt') {
    kdfparams = json.Crypto.kdfparams

    // FIXME: support progress reporting callback
    derivedKey = scryptsy(new Buffer(password), new Buffer(kdfparams.salt, 'hex'), kdfparams.n, kdfparams.r, kdfparams.p, kdfparams.dklen)
  } else if (json.Crypto.kdf === 'pbkdf2') {
    kdfparams = json.Crypto.kdfparams

    if (kdfparams.prf !== 'hmac-sha256') {
      throw new Error('Unsupported parameters to PBKDF2')
    }

    derivedKey = crypto.pbkdf2Sync(new Buffer(password), new Buffer(kdfparams.salt, 'hex'), kdfparams.c, kdfparams.dklen, 'sha256')
  } else {
    throw new Error('Unsupported key derivation scheme')
  }

  var ciphertext = new Buffer(json.Crypto.ciphertext, 'hex')

  var mac = ethUtil.sha3(Buffer.concat([ derivedKey.slice(16, 32), ciphertext ]))
  if (mac.toString('hex') !== json.Crypto.mac) {
    throw new Error('Key derivation failed - possibly wrong passphrase')
  }

  var decipher = crypto.createDecipheriv(json.Crypto.cipher, derivedKey.slice(0, 16), new Buffer(json.Crypto.cipherparams.iv, 'hex'))
  var seed = decipherBuffer(decipher, ciphertext, 'hex')

  // FIXME: Remove PKCS#7 padding here?

  return new Wallet(seed)
}

/*
 * Based on https://github.com/ethereum/pyethsaletool/blob/master/pyethsaletool.py
 * JSON fields: encseed, ethaddr, btcaddr, email
 */
Wallet.fromEthSale = function (input, password) {
  assert(typeof password === 'string')
  var json = (typeof input === 'object') ? input : JSON.parse(input)

  var encseed = new Buffer(json.encseed, 'hex')

  // key derivation
  var derivedKey = crypto.pbkdf2Sync(password, password, 2000, 32, 'sha256').slice(0, 16)

  // seed decoding (IV is first 16 bytes)
  var decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, encseed.slice(0, 16))
  var seed = decipherBuffer(decipher, encseed.slice(16))

  // FIXME: Remove PKCS#7 padding here?

  var wallet = new Wallet(ethUtil.sha3(seed))
  if (wallet.getAddress().toString('hex') !== json.ethaddr) {
    throw new Error('Decoded key mismatch - possibly wrong passphrase')
  }
  return wallet
}

/*
 * opts:
 * - digest - digest algorithm, defaults to md5
 * - count - hash iterations
 * - keysize - desired key size
 * - ivsize - desired IV size
 *
 * Algorithm form https://www.openssl.org/docs/manmaster/crypto/EVP_BytesToKey.html
 *
 * FIXME: not optimised at all
 */
function evp_kdf (data, salt, opts) {
  // A single EVP iteration, returns `D_i`, where block equlas to `D_(i-1)`
  function iter (block) {
    var hash = crypto.createHash(opts.digest || 'md5')
    hash.update(block)
    hash.update(data)
    hash.update(salt)
    block = hash.digest()

    for (var i = 1; i < (opts.count || 1); i++) {
      hash = crypto.createHash(opts.digest || 'md5')
      hash.update(block)
      block = hash.digest()
    }

    return block
  }

  var keysize = opts.keysize || 16
  var ivsize = opts.ivsize || 16

  var ret = []

  var i = 0
  while (Buffer.concat(ret).length < (keysize + ivsize)) {
    ret[i] = iter((i === 0) ? new Buffer(0) : ret[i - 1])
    i++
  }

  var tmp = Buffer.concat(ret)

  return {
    key: tmp.slice(0, keysize),
    iv: tmp.slice(keysize, keysize + ivsize)
  }
}

// http://stackoverflow.com/questions/25288311/cryptojs-aes-pattern-always-ends-with
function decodeCryptojsSalt (input) {
  var ciphertext = new Buffer(input, 'base64')
  if (ciphertext.slice(0, 8).toString() === 'Salted__') {
    return {
      salt: ciphertext.slice(8, 16),
      ciphertext: ciphertext.slice(16)
    }
  } else {
    return {
      ciphertext: ciphertext
    }
  }
}

/*
 * This wallet format is created by https://github.com/SilentCicero/ethereumjs-accounts
 * and used on https://www.myetherwallet.com/
 */
Wallet.fromEtherWallet = function (input, password) {
  var json = (typeof input === 'object') ? input : JSON.parse(input)

  var privKey
  if (!json.locked) {
    if (json.private.length !== 64) {
      throw new Error('Invalid private key length')
    }

    privKey = new Buffer(json.private, 'hex')
  } else {
    if (typeof password !== 'string') {
      throw new Error('Password required')
    }
    if (password.length < 7) {
      throw new Error('Password must be at least 7 characters')
    }

    // the "encrypted" version has the low 4 bytes
    // of the hash of the address appended
    var cipher = json.encrypted ? json.private.slice(0, 128) : json.private

    // decode openssl ciphertext + salt encoding
    cipher = decodeCryptojsSalt(cipher)

    // derive key/iv using OpenSSL EVP as implemented in CryptoJS
    var evp = evp_kdf(new Buffer(password), cipher.salt, { keysize: 32, ivsize: 16 })

    var decipher = crypto.createDecipheriv('aes-256-cbc', evp.key, evp.iv)
    privKey = decipherBuffer(decipher, new Buffer(cipher.ciphertext))

    // NOTE: yes, they've run it through UTF8
    privKey = new Buffer(utf8.decode(privKey.toString()), 'hex')
  }

  var wallet = new Wallet(privKey)

  if (wallet.getAddressString() !== json.address) {
    throw new Error('Invalid private key or address')
  }

  return wallet
}

Wallet.fromEtherCamp = function (passphrase) {
  return new Wallet(ethUtil.sha3(new Buffer(passphrase)))
}

Wallet.fromKryptoKit = function (entropy, password) {
  function kryptoKitBrokenScryptSeed (buf) {
    // js-scrypt calls `new Buffer(String(salt), 'utf8')` on the seed even though it is a buffer
    //
    // The `buffer`` implementation used does the below transformation (doesn't matches the current version):
    // https://github.com/feross/buffer/blob/67c61181b938b17d10dbfc0a545f713b8bd59de8/index.js

    function decodeUtf8Char (str) {
      try {
        return decodeURIComponent(str)
      } catch (err) {
        return String.fromCharCode(0xFFFD) // UTF 8 invalid char
      }
    }

    var res = ''
    var tmp = ''

    for (var i = 0; i < buf.length; i++) {
      if (buf[i] <= 0x7F) {
        res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i])
        tmp = ''
      } else {
        tmp += '%' + buf[i].toString(16)
      }
    }

    return new Buffer(res + decodeUtf8Char(tmp))
  }

  if (entropy[0] === '#') {
    entropy = entropy.slice(1)
  }

  var type = entropy[0]
  entropy = entropy.slice(1)

  var privKey
  if (type === 'd') {
    privKey = ethUtil.sha256(entropy)
  } else if (type === 'q') {
    if (typeof password !== 'string') {
      throw new Error('Password required')
    }

    var encryptedSeed = ethUtil.sha256(new Buffer(entropy.slice(0, 30)))
    var checksum = entropy.slice(30, 46)

    var salt = kryptoKitBrokenScryptSeed(encryptedSeed)
    var aesKey = scryptsy(new Buffer(password, 'utf8'), salt, 16384, 8, 1, 32)

    /* FIXME: try to use `crypto` instead of `aesjs`

    // NOTE: ECB doesn't use the IV, so it can be anything
    var decipher = crypto.createDecipheriv("aes-256-ecb", aesKey, new Buffer(0))

    // FIXME: this is a clear abuse, but seems to match how ECB in aesjs works
    privKey = Buffer.concat([
      decipher.update(encryptedSeed).slice(0, 16),
      decipher.update(encryptedSeed).slice(0, 16),
    ])
    */

    /* eslint-disable new-cap */
    var decipher = new aesjs.ModeOfOperation.ecb(aesKey)
    /* eslint-enable new-cap */
    privKey = Buffer.concat([
      decipher.decrypt(encryptedSeed.slice(0, 16)),
      decipher.decrypt(encryptedSeed.slice(16, 32))
    ])

    if (checksum.length > 0) {
      if (checksum !== ethUtil.sha256(ethUtil.sha256(privKey)).slice(0, 8).toString('hex')) {
        throw new Error('Failed to decrypt input - possibly invalid passphrase')
      }
    }
  } else {
    throw new Error('Unsupported or invalid entropy type')
  }

  return new Wallet(privKey)
}

Wallet.fromQuorumWallet = function (passphrase, userid) {
  assert(passphrase.length >= 10)
  assert(userid.length >= 10)

  var seed = passphrase + userid
  seed = crypto.pbkdf2Sync(seed, seed, 2000, 32, 'sha256');

  return new Wallet(seed)
}

module.exports = Wallet
