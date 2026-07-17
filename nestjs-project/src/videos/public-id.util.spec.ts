import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('returns the requested length using URL-safe alphabet', () => {
    const id = generatePublicId(11);
    expect(id).toHaveLength(11);
    expect(id).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('produces distinct values across calls', () => {
    const a = generatePublicId(11);
    const b = generatePublicId(11);
    expect(a).not.toBe(b);
  });
});
