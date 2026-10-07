import { describe, expect, it } from 'vitest';
import { S3Storage } from '../../src/lib/storage.js';

const storage = new S3Storage({
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET_AVATARS: 'cf-avatars',
  S3_BUCKET_IMPORTS: 'cf-imports',
  S3_BUCKET_EXPORTS: 'cf-exports',
});

describe('S3Storage presigning', () => {
  it('signs PUT URLs against the PUBLIC endpoint, path-style, 15 min TTL', async () => {
    const url = new URL(await storage.presignPut('avatars', 'user-1/abc', 'image/png'));
    expect(url.origin).toBe('http://localhost');
    expect(url.pathname).toBe('/cf-avatars/user-1/abc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('does not add SDK checksum parameters (they break browser uploads)', async () => {
    const url = (await storage.presignPut('imports', 'user-1/file.csv', 'text/csv')).toLowerCase();
    expect(url).not.toContain('x-amz-checksum');
    expect(url).not.toContain('x-amz-sdk-checksum-algorithm');
  });

  it('signs the content type, so the uploader cannot choose another one', async () => {
    const url = new URL(await storage.presignPut('avatars', 'user-1/abc', 'image/png'));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
  });

  it('adds a content-disposition to GET URLs when a download name is given', async () => {
    const url = new URL(await storage.presignGet('exports', 'user-1/job.csv', 'my "portfolio".csv'));
    expect(url.pathname).toBe('/cf-exports/user-1/job.csv');
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="my portfolio.csv"');
  });
});
