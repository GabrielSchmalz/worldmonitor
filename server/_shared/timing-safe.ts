import { createHash } from 'node:crypto';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';

export function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    const dummy = Buffer.alloc(aBuf.length);
    cryptoTimingSafeEqual(dummy, dummy);
    return false;
  }
  return cryptoTimingSafeEqual(aBuf, bBuf);
}

export { createHash };
