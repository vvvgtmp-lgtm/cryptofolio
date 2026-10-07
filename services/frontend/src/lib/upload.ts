/** PUT a file straight to object storage using a presigned URL (no auth header: the URL is the credential). */
export async function uploadFile(url: string, file: File): Promise<void> {
  const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
}
