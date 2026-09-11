/**
 * Google Cloud Storage helpers shared by the meeting functions.
 *
 * getGcsAccessToken / uploadToGcs are moved verbatim from
 * focusos-transcribe-meeting + focusos-process-meeting (same behaviour, one
 * copy). listChunkCount / composeObjects / downloadObject are new and serve
 * the segmented transcription worker.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export async function getGcsAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = btoa(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/devstorage.read_write",
      aud: sa.token_uri,
      exp: now + 3600,
      iat: now,
    })
  );
  const unsignedToken = `${header}.${claim}`;

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const jwt = `${unsignedToken}.${signature}`;

  const resp = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const { access_token } = await resp.json();
  return access_token;
}

export async function uploadToGcs(
  token: string,
  bucket: string,
  path: string,
  data: Uint8Array | string,
  contentType: string
): Promise<string> {
  const encodedPath = encodeURIComponent(path);
  // Cast: TS types a generic Uint8Array as Uint8Array<ArrayBufferLike>, which
  // does not satisfy BodyInit. Runtime behaviour is unchanged.
  const body = (typeof data === "string"
    ? new TextEncoder().encode(data)
    : data) as unknown as BodyInit;
  const resp = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodedPath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
      },
      body,
    }
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GCS upload failed: ${err}`);
  }
  const result = await resp.json();
  return `gs://${bucket}/${result.name}`;
}

/**
 * Every object name under `prefix`, paging the list API (its default page size
 * is 1000 and a long meeting can exceed it).
 */
export async function listObjectNames(
  token: string,
  bucket: string,
  prefix: string
): Promise<string[]> {
  const names: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      prefix,
      fields: "items(name),nextPageToken",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const resp = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`GCS list failed: ${err}`);
    }
    const page = await resp.json();
    for (const item of page.items || []) {
      if (item?.name) names.push(item.name as string);
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);

  return names;
}

/**
 * How many `${folder}/chunks/NNNNN.webm` objects exist.
 */
export async function listChunkCount(
  token: string,
  bucket: string,
  folder: string
): Promise<number> {
  const prefix = `${folder}/chunks/`;
  const pattern = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{5}\\.webm$`
  );
  const names = await listObjectNames(token, bucket, prefix);
  return names.filter((name) => pattern.test(name)).length;
}

/**
 * Byte-concatenate up to 32 objects of the SAME bucket into `dest`.
 * Source order is preserved, which is what makes init + clusters decodable.
 */
export async function composeObjects(
  token: string,
  bucket: string,
  sources: string[],
  dest: string,
  contentType: string
): Promise<string> {
  if (sources.length === 0) throw new Error("composeObjects: no sources");
  if (sources.length > 32) {
    throw new Error(`composeObjects: ${sources.length} sources exceeds the GCS limit of 32`);
  }
  const resp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(dest)}/compose`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceObjects: sources.map((name) => ({ name })),
        destination: { contentType },
      }),
    }
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GCS compose failed: ${err}`);
  }
  await resp.json();
  return dest;
}

/** Download one object's bytes. */
export async function downloadObject(
  token: string,
  bucket: string,
  name: string
): Promise<Uint8Array> {
  const resp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GCS download failed for ${name}: ${err}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

/** Delete one object. A 404 counts as success (the object is already gone). */
export async function deleteObject(
  token: string,
  bucket: string,
  name: string
): Promise<void> {
  const resp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`GCS delete failed for ${name}: ${await resp.text()}`);
  }
  await resp.body?.cancel();
}
