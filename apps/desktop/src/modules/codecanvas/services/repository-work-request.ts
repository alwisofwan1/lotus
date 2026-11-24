const REPOSITORY_WORK_RE =
  /\b(?:analy[sz]e|analysis|explain|review|inspect|audit|understand|summari[sz]e|analisis|analisa|jelaskan|periksa|tinjau|pahami|rangkum)\b[\s\S]{0,80}\b(?:project|repository|repo|codebase|source|proyek|repositori|kode)(?:\s+(?:ini|this))?\b|\b(?:project|repository|repo|codebase|source|proyek|repositori|kode)(?:\s+(?:ini|this))?\b[\s\S]{0,80}\b(?:analy[sz]e|analysis|explain|review|inspect|audit|understand|summari[sz]e|analisis|analisa|jelaskan|periksa|tinjau|pahami|rangkum)\b/iu;

/** Repository work requires a tool-capable coding agent; the Canvas utility planner cannot inspect files. */
export function isRepositoryWorkRequest(text: string): boolean {
  return REPOSITORY_WORK_RE.test(text);
}
