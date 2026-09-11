/**
 * Gemini helpers shared by the meeting functions.
 *
 * uploadToGeminiFileAPI is moved verbatim from focusos-process-meeting (it
 * streams GCS -> Gemini in 8 MB pieces and never buffers a whole file).
 * The summary prompt / parser / generateSummary are the focusos-transcribe-meeting
 * versions. waitForGeminiFileActive, deleteGeminiFile and transcribeSegment
 * are new and serve the segmented transcription worker.
 */

const GEMINI_MODEL = "gemini-2.5-flash";

/* ─── File API ──────────────────────────────────────────────────── */

export async function uploadToGeminiFileAPI(
  apiKey: string,
  gcsToken: string,
  gcsBucket: string,
  gcsObjectPath: string,
  mimeType: string,
  displayName: string
): Promise<string> {
  // Step 1: Get file size from GCS metadata (no download)
  const encodedPath = encodeURIComponent(gcsObjectPath);
  const metaResp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${gcsBucket}/o/${encodedPath}`,
    { headers: { Authorization: `Bearer ${gcsToken}` } }
  );
  if (!metaResp.ok) {
    const err = await metaResp.text();
    throw new Error(`GCS metadata fetch failed: ${err}`);
  }
  const metadata = await metaResp.json();
  const fileSize = parseInt(metadata.size, 10);
  console.log(`File size from GCS: ${fileSize} bytes (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

  // Step 2: Initiate resumable upload to Gemini File API
  const initResp = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(fileSize),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file: { display_name: displayName },
      }),
    }
  );

  if (!initResp.ok) {
    const err = await initResp.text();
    throw new Error(`Gemini File API init failed: ${err}`);
  }

  const uploadUrl = initResp.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) throw new Error("No upload URL returned from Gemini File API");
  console.log("Got Gemini resumable upload URL");

  // Step 3: Stream from GCS → Gemini in chunks (never buffer full file)
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks
  const downloadResp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${gcsBucket}/o/${encodedPath}?alt=media`,
    { headers: { Authorization: `Bearer ${gcsToken}` } }
  );
  if (!downloadResp.ok || !downloadResp.body) {
    throw new Error(`GCS download failed: ${await downloadResp.text()}`);
  }

  const reader = downloadResp.body.getReader();
  let uploadOffset = 0;
  let buffer = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();

    if (value) {
      // Append to buffer
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;
    }

    // Send chunks when we have enough data, or on final read
    while (buffer.length >= CHUNK_SIZE || (done && buffer.length > 0)) {
      const isLast = done && buffer.length <= CHUNK_SIZE;
      const chunkSize = Math.min(buffer.length, CHUNK_SIZE);
      const chunk = buffer.slice(0, chunkSize);
      buffer = buffer.slice(chunkSize);

      const command = isLast ? "upload, finalize" : "upload";

      const uploadResp = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.length),
          "X-Goog-Upload-Offset": String(uploadOffset),
          "X-Goog-Upload-Command": command,
        },
        body: chunk as unknown as BodyInit,
      });

      if (!uploadResp.ok) {
        const err = await uploadResp.text();
        throw new Error(`Gemini chunked upload failed at offset ${uploadOffset}: ${err}`);
      }

      uploadOffset += chunk.length;
      console.log(`Uploaded ${(uploadOffset / 1024 / 1024).toFixed(1)} MB / ${(fileSize / 1024 / 1024).toFixed(1)} MB to Gemini`);

      if (isLast) {
        // Parse the final response
        const uploadResult = await uploadResp.json();
        const fileUri = uploadResult.file?.uri;
        if (!fileUri) throw new Error("No file URI returned from Gemini File API");
        console.log(`File uploaded to Gemini: ${fileUri}, state: ${uploadResult.file?.state}`);
        return fileUri;
      } else {
        await uploadResp.text(); // consume response body
      }
    }

    if (done) break;
  }

  throw new Error("Upload loop ended without finalizing");
}

function geminiFileName(fileUri: string): string {
  const match = fileUri.match(/files\/([^/]+)$/);
  if (!match) throw new Error(`Cannot parse file name from URI: ${fileUri}`);
  return match[1];
}

/**
 * Poll a freshly uploaded file until it reports ACTIVE. Bounded by capMs so
 * the caller stays well inside its own request budget.
 */
export async function waitForGeminiFileActive(
  apiKey: string,
  fileUri: string,
  capMs: number
): Promise<void> {
  const fileName = geminiFileName(fileUri);
  const deadline = Date.now() + capMs;
  let state = "PROCESSING";

  while (Date.now() < deadline) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/files/${fileName}?key=${apiKey}`
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Failed to check file status: ${err}`);
    }
    const data = await resp.json();
    state = data.state;
    if (state === "ACTIVE") return;
    if (state === "FAILED") throw new Error("Gemini file processing failed");
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Gemini file did not become ACTIVE within ${Math.round(capMs / 1000)}s (state: ${state})`);
}

/** Best-effort cleanup; callers treat failure as non-critical. */
export async function deleteGeminiFile(apiKey: string, fileUri: string): Promise<void> {
  const fileName = geminiFileName(fileUri);
  await fetch(
    `https://generativelanguage.googleapis.com/v1beta/files/${fileName}?key=${apiKey}`,
    { method: "DELETE" }
  );
}

/* ─── Transcription ─────────────────────────────────────────────── */

/** One generateContent call over ONE segment file. Returns the raw text. */
export async function transcribeSegment(
  apiKey: string,
  fileUri: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { fileData: { mimeType, fileUri } },
              { text: prompt },
            ],
          },
        ],
      }),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Transcription failed: ${errText}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Empty transcript returned from Gemini");
  return text;
}

/* ─── Summary ───────────────────────────────────────────────────── */

export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1");
}

export function getSummaryPrompt(transcript: string, detailLevel: string, durationSeconds: number): string {
  const durationMin = Math.round(durationSeconds / 60);
  const levelConfig: Record<string, { maxSections: number; bulletGuidance: string; overviewGuidance: string; description: string }> = {
    concise: {
      maxSections: durationMin < 5 ? 2 : durationMin < 30 ? 3 : 5,
      bulletGuidance: "1-3 SHORT bullets per section. Only decisions and action items.",
      overviewGuidance: "1-2 sentences. What happened and what is next.",
      description: "Only key decisions, action items, and major takeaways. Ruthlessly cut fluff.",
    },
    standard: {
      maxSections: durationMin < 5 ? 3 : durationMin < 30 ? 5 : 6,
      bulletGuidance: "2-5 bullets per section. Include key context.",
      overviewGuidance: "2-4 sentences. Key topics, decisions, and outcomes.",
      description: "Main discussion points and conclusions with supporting context.",
    },
    detailed: {
      maxSections: durationMin < 5 ? 4 : durationMin < 30 ? 6 : 8,
      bulletGuidance: "Thorough but never redundant.",
      overviewGuidance: "3-6 sentences. Comprehensive executive summary.",
      description: "Thorough capture including nuances, disagreements, and supporting arguments.",
    },
  };
  const config = levelConfig[detailLevel] || levelConfig.concise;

  return `Analyze this meeting transcript and provide a structured summary.
Detail level: ${detailLevel} — ${config.description}

CRITICAL RULES:
1. Think like an executive assistant. Extract ONLY what matters.
2. Do NOT repeat information.
3. Each bullet must convey a UNIQUE piece of information.
4. Omit filler, greetings, small talk entirely.
5. Do NOT use any markdown formatting. Plain text only.
6. Headings should be short descriptive labels (3-6 words).
7. Maximum ${config.maxSections} sections. ${config.bulletGuidance}
8. Overview: ${config.overviewGuidance}
9. Return ONLY valid JSON.

Return JSON: { "overview": "string", "outline": [{ "heading": "string", "points": ["string"] }] }

Transcript:
${transcript}`;
}

export function parseGeminiSummaryResponse(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText);
    if (parsed.overview) {
      parsed.overview = stripMarkdown(parsed.overview);
      if (parsed.outline) {
        parsed.outline = parsed.outline.map((s: any) => ({
          heading: stripMarkdown(s.heading || ""),
          points: (s.points || []).map((p: string) => stripMarkdown(p)),
        }));
      }
      return JSON.stringify(parsed);
    }
    return JSON.stringify({ overview: stripMarkdown(rawText), outline: [] });
  } catch {
    let cleaned = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const jsonStart = cleaned.search(/[\{\[]/);
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      cleaned = cleaned.substring(jsonStart, jsonEnd + 1)
        .replace(/,\s*}/g, "}").replace(/,\s*]/g, "]").replace(/[\x00-\x1F\x7F]/g, "");
      try {
        const parsed = JSON.parse(cleaned);
        parsed.overview = stripMarkdown(parsed.overview || "");
        if (parsed.outline) {
          parsed.outline = parsed.outline.map((s: any) => ({
            heading: stripMarkdown(s.heading || ""),
            points: (s.points || []).map((p: string) => stripMarkdown(p)),
          }));
        }
        return JSON.stringify(parsed);
      } catch {
        return JSON.stringify({ overview: stripMarkdown(rawText), outline: [] });
      }
    }
    return JSON.stringify({ overview: stripMarkdown(rawText), outline: [] });
  }
}

export async function generateSummary(
  apiKey: string,
  transcript: string,
  detailLevel: string,
  durationSeconds: number
): Promise<string> {
  const prompt = getSummaryPrompt(transcript, detailLevel, durationSeconds);
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );
  if (!resp.ok) {
    console.error("Summary generation failed:", await resp.text());
    return JSON.stringify({ overview: "Summary generation failed.", outline: [] });
  }
  const data = await resp.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!rawText) return JSON.stringify({ overview: "No summary available.", outline: [] });
  return parseGeminiSummaryResponse(rawText);
}
