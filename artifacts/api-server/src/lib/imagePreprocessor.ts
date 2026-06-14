/**
 * imagePreprocessor — ImageMagick-based image enhancement for OCR recovery.
 *
 * ─── ARCHITECTURE RULE ───────────────────────────────────────────────────────
 * This module is ONLY called by the recovery path in pdfExtractor.ts.
 * It is NEVER called on a first-pass OCR attempt.
 * The original OCR pipeline is completely UNCHANGED.
 *
 * ─── FEATURE FLAG ────────────────────────────────────────────────────────────
 * OCR_RECOVERY_ENABLED (env var, default: 'true')
 *   Set to 'false' to disable the entire recovery pipeline. When disabled,
 *   low-confidence OCR results pass through as-is (existing behaviour).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Uses ImageMagick 7 (`magick` command). Applies:
 *   1. Grayscale conversion  — removes colour noise, reduces file size
 *   2. Normalize             — stretches contrast to full 0–255 range
 *   3. Sharpen               — improves character edge definition
 *   4. Threshold             — binarizes the image (pure black/white)
 *
 * These transforms are commonly recommended for improving OCR accuracy on
 * scanned documents with faint text, uneven lighting, or low contrast.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

// ImageMagick 7 binary (`convert` is deprecated in v7)
const MAGICK_BIN = 'magick';

// ─── Feature flag ─────────────────────────────────────────────────────────────

/** Returns true when the recovery pipeline is enabled (default: true). */
export function isRecoveryEnabled(): boolean {
  return process.env.OCR_RECOVERY_ENABLED !== 'false';
}

// ─── Core preprocessing ───────────────────────────────────────────────────────

/**
 * Applies grayscale → normalize → sharpen → threshold to a single PNG image.
 *
 * @param inputPath   Path to the original rendered PNG from pdftoppm.
 * @param outputDir   Directory where the enhanced PNG is written.
 * @returns           Path to the enhanced PNG file.
 * @throws            If ImageMagick fails (caller should catch and skip).
 */
export async function preprocessForOcr(
  inputPath: string,
  outputDir: string,
): Promise<string> {
  const basename    = path.basename(inputPath, '.png');
  const outputPath  = path.join(outputDir, `${basename}_enhanced.png`);

  await execFileAsync(
    MAGICK_BIN,
    [
      inputPath,
      '-colorspace', 'Gray',  // → grayscale
      '-normalize',            // → stretch contrast
      '-sharpen',  '0x1.5',   // → sharpen edges
      '-threshold', '50%',    // → binarize (black/white only)
      outputPath,
    ],
    { timeout: 30_000 },
  );

  return outputPath;
}

/**
 * Preprocesses a batch of PNG images. Skips individual failures with a warning.
 *
 * @param imagePaths  Original rendered PNGs (e.g. from pdftoppm at 300 DPI).
 * @param outputDir   Directory for enhanced output files.
 * @returns           Array of enhanced PNG paths (may be shorter than input).
 */
export async function preprocessBatch(
  imagePaths: string[],
  outputDir: string,
): Promise<string[]> {
  const results: string[] = [];

  for (const imgPath of imagePaths) {
    try {
      const enhanced = await preprocessForOcr(imgPath, outputDir);
      results.push(enhanced);
    } catch (err) {
      console.warn(
        `[imagePreprocessor] Skipping ${path.basename(imgPath)} — ` +
        (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return results;
}

// ─── Directory helper ─────────────────────────────────────────────────────────

/** Creates and returns a fresh temp directory for preprocessed images. */
export function createPreprocessDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `sage_preproc_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Deletes a preprocessing temp directory (best-effort, ignores errors). */
export function cleanupPreprocessDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
