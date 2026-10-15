import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
export async function runtimeFingerprint() {
  const directory='rust/teia-kernel/src';
  const files=(await readdir(directory)).filter(p=>/\.(rs|json)$/.test(p)).sort();
  const hash=createHash('sha256');
  for(const name of files){hash.update(name+'\0');hash.update(await readFile(`${directory}/${name}`));}
  return hash.digest('hex');
}

export async function runtimeFingerprint64() {
  let result=0xcbf29ce484222325n;
  for(const name of (await readdir('rust/teia-kernel/src')).filter(p=>/\.(rs|json)$/.test(p)).sort()) {
    for(const byte of Buffer.concat([Buffer.from(name+'\0'),await readFile('rust/teia-kernel/src/'+name)]))result=BigInt.asUintN(64,(result^BigInt(byte))*0x100000001b3n);
  }
  return result;
}
