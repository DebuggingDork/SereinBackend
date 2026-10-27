import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const encode = (pem: string) => Buffer.from(pem).toString('base64');

console.log('# backend/.env');
console.log(`GATE_PASS_PRIVATE_KEY=${encode(privateKey)}`);
console.log('');
console.log('# frontend/.env.local');
console.log(`GATE_PASS_PUBLIC_KEY=${encode(publicKey)}`);
