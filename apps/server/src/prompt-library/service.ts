import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getLocalAssetMetadata, getPromptLibraryPath, getPromptLibraryPrompt, loadPromptLibrary, writePngTextChunk } from "@snarkroute/nodes";

export type CreatePromptAssetBody = {
  title?: string;
  slug?: string;
  category?: string;
  description?: string;
  tags?: string[];
  prompt?: string;
  negativePrompt?: string;
  modelHints?: string[];
  source?: {
    runId?: string;
    routeId?: string;
    nodeId?: string;
    outputId?: string;
  };
  imagePath?: string;
  imageDataBase64?: string;
  assetFormat?: "markdown" | "png";
};

export type UpdatePromptAssetBody = {
  status?: string;
  category?: string;
};

const promptAssetStatuses = new Set(["draft", "candidate", "approved", "published", "archived"]);

export async function updatePromptAsset(category: string, id: string, body: UpdatePromptAssetBody) {
  const prompt = await loadPromptAssetForMutation(category, id);
  const status = cleanSingleLine(body.status);
  const nextCategory = cleanSingleLine(body.category);
  if (!status && !nextCategory) throw new Error("status or category is required.");
  if (status && !promptAssetStatuses.has(status)) throw new Error(`Unsupported prompt status "${status}".`);
  if (nextCategory && !safePathSegment(nextCategory)) throw new Error("Invalid prompt category.");

  const text = await readFile(prompt.path, "utf8");
  const currentCategory = prompt.category;
  const targetCategory = nextCategory || currentCategory;
  const updatedText = updatePromptFrontmatter(text, {
    status: status || prompt.status || "candidate",
    category: targetCategory
  });

  const root = resolve(getPromptLibraryPath());
  const targetDirectory = resolve(root, targetCategory);
  if (!targetDirectory.startsWith(root)) throw new Error("Invalid prompt category.");
  await mkdir(targetDirectory, { recursive: true });
  const targetPath = join(targetDirectory, basename(prompt.path));
  await writeFile(prompt.path, updatedText, "utf8");
  if (targetPath !== prompt.path) {
    if (existsSync(targetPath)) throw new Error(`Prompt asset "${targetCategory}/${id}" already exists.`);
    await rename(prompt.path, targetPath);
    await movePromptPreview(prompt.previewImage, dirname(prompt.path), targetDirectory);
  }
  return { category: targetCategory, id, path: targetPath };
}

export async function deletePromptAsset(category: string, id: string) {
  const prompt = await loadPromptAssetForMutation(category, id, { allowPng: true });
  await rm(prompt.path, { force: true });
  if (prompt.path.endsWith(".prompt.md")) await deletePromptPreview(prompt.previewImage, dirname(prompt.path));
  return { category: prompt.category, id };
}

async function loadPromptAssetForMutation(category: string, id: string, options: { allowPng?: boolean } = {}) {
  const library = await loadPromptLibrary();
  const prompt = getPromptLibraryPrompt(library, category, id);
  if (!prompt) throw new Error(`Prompt "${category}/${id}" was not found.`);
  const root = resolve(getPromptLibraryPath());
  const promptPath = resolve(prompt.path);
  if (!promptPath.startsWith(root)) throw new Error("Prompt path is outside the prompt library.");
  if (!promptPath.endsWith(".prompt.md") && !(options.allowPng && promptPath.endsWith(".prompt.png"))) {
    throw new Error("Only local prompt assets can be edited from Studio.");
  }
  return { ...prompt, path: promptPath };
}

function updatePromptFrontmatter(text: string, updates: { status: string; category: string }): string {
  const match = /^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n)?[\s\S]*)$/u.exec(text);
  if (!match) throw new Error("Prompt file requires YAML frontmatter delimited by ---.");
  let frontmatter = upsertYamlScalarLine(match[2], "category", updates.category);
  frontmatter = upsertYamlScalarLine(frontmatter, "status", updates.status);
  return `${match[1]}${frontmatter}${match[3]}`;
}

function upsertYamlScalarLine(frontmatter: string, key: string, value: string): string {
  const line = `${key}: ${yamlScalar(value)}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*.*$`, "m");
  if (pattern.test(frontmatter)) return frontmatter.replace(pattern, line);
  return `${frontmatter.replace(/\s*$/u, "")}\n${line}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function movePromptPreview(previewImage: string | undefined, fromDirectory: string, toDirectory: string): Promise<void> {
  const previewPath = promptPreviewLocalPath(previewImage, fromDirectory);
  if (!previewPath || !existsSync(previewPath)) return;
  const targetPath = join(toDirectory, basename(previewPath));
  if (targetPath === previewPath || existsSync(targetPath)) return;
  await rename(previewPath, targetPath);
}

async function deletePromptPreview(previewImage: string | undefined, promptDirectory: string): Promise<void> {
  const previewPath = promptPreviewLocalPath(previewImage, promptDirectory);
  if (!previewPath) return;
  await rm(previewPath, { force: true });
}

function promptPreviewLocalPath(previewImage: string | undefined, promptDirectory: string): string | null {
  if (!previewImage || /^https?:\/\//i.test(previewImage)) return null;
  const root = resolve(getPromptLibraryPath());
  const previewPath = resolve(promptDirectory, previewImage);
  if (!previewPath.startsWith(root)) return null;
  return previewPath;
}

export async function createPromptAssetFromGeneratedImage(body: CreatePromptAssetBody) {
  const title = cleanSingleLine(body.title) || "Generated Image Prompt";
  const category = safePathSegment(body.category || "image-generation") || "image-generation";
  const slug = safePathSegment(body.slug || slugFromTitle(title));
  const prompt = String(body.prompt ?? "").trim();
  if (!slug) throw new Error("Slug is required.");
  if (!prompt) throw new Error("Prompt body is required.");
  if (!body.imagePath && !body.imageDataBase64) throw new Error("imagePath or imageDataBase64 is required.");

  const imageBuffer = body.imageDataBase64
    ? Buffer.from(body.imageDataBase64, "base64")
    : await readPromptAssetImageFromPath(body.imagePath ?? "");
  if (imageBuffer.length <= 0) throw new Error("Prompt asset image is empty.");
  const directory = resolve(getPromptLibraryPath(), category);
  const root = resolve(getPromptLibraryPath());
  if (!directory.startsWith(root)) throw new Error("Invalid prompt library category.");
  await mkdir(directory, { recursive: true });

  const promptPath = join(directory, `${slug}.prompt.md`);
  const previewPath = join(directory, `${slug}.preview.png`);
  const pngPromptPath = join(directory, `${slug}.prompt.png`);
  const assetFormat = body.assetFormat === "png" ? "png" : "markdown";
  if (existsSync(promptPath) || existsSync(previewPath) || existsSync(pngPromptPath)) {
    throw new Error(`Prompt asset "${category}/${slug}" already exists. Choose a different slug.`);
  }
  const tags = (body.tags ?? []).map(cleanSingleLine).filter(Boolean);
  const modelHints = (body.modelHints ?? []).map(cleanSingleLine).filter(Boolean);
  const source = {
    type: "generated-image",
    runId: cleanSingleLine(body.source?.runId) || undefined,
    routeId: cleanSingleLine(body.source?.routeId) || undefined,
    nodeId: cleanSingleLine(body.source?.nodeId) || undefined,
    outputId: cleanSingleLine(body.source?.outputId) || undefined
  };
  if (assetFormat === "png") {
    const metadata = {
      schema: "snarkroute.prompt-image.v0",
      id: slug,
      title,
      category,
      prompt,
      negativePrompt: String(body.negativePrompt ?? "").trim() || undefined,
      description: cleanSingleLine(body.description) || title,
      kind: "text/prompt",
      status: "candidate",
      tags: tags.length ? tags : ["image"],
      modelHints: modelHints.length ? modelHints : undefined,
      source
    };
    await writeFile(pngPromptPath, writePngTextChunk(imageBuffer, "snarkroute:prompt", JSON.stringify(metadata)));
    return { promptPath: pngPromptPath, previewPath: pngPromptPath, category, slug, assetFormat };
  }
  const frontmatter = [
    "---",
    `id: ${yamlScalar(slug)}`,
    `title: ${yamlScalar(title)}`,
    `category: ${yamlScalar(category)}`,
    `description: ${yamlScalar(cleanSingleLine(body.description) || title)}`,
    "kind: system",
    "tags:",
    ...(tags.length ? tags : ["image"]).map((tag) => `- ${yamlScalar(tag)}`),
    `previewImage: ${yamlScalar(`${slug}.preview.png`)}`,
    "status: candidate",
    "source:",
    ...Object.entries(source)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `  ${key}: ${yamlScalar(String(value))}`),
    ...(modelHints.length ? ["modelHints:", ...modelHints.map((hint) => `- ${yamlScalar(hint)}`)] : []),
    ...(String(body.negativePrompt ?? "").trim() ? [`negativePrompt: ${yamlScalar(String(body.negativePrompt ?? "").trim())}`] : []),
    "---",
    "",
    prompt,
    ""
  ].join("\n");
  await writeFile(promptPath, frontmatter, "utf8");
  await writeFile(previewPath, imageBuffer);
  return { promptPath, previewPath, category, slug, assetFormat };
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

async function readPromptAssetImageFromPath(path: string): Promise<Buffer> {
  const imageMetadata = await getLocalAssetMetadata(path, "image");
  if (imageMetadata.sizeBytes <= 0) throw new Error(`Preview image is empty: ${imageMetadata.path}`);
  if (imageMetadata.mimeType !== "image/png") throw new Error("Prompt PNG assets require a PNG image output.");
  return readFile(imageMetadata.path);
}

function cleanSingleLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safePathSegment(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function slugFromTitle(value: string): string {
  return safePathSegment(value) || `prompt-${Date.now()}`;
}
