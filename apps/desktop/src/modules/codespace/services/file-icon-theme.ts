import manifest from "material-icon-theme/dist/material-icons.json";
import bunIcon from "material-icon-theme/icons/bun.svg";
import cIcon from "material-icon-theme/icons/c.svg";
import consoleIcon from "material-icon-theme/icons/console.svg";
import cppIcon from "material-icon-theme/icons/cpp.svg";
import cssIcon from "material-icon-theme/icons/css.svg";
import databaseIcon from "material-icon-theme/icons/database.svg";
import dockerIcon from "material-icon-theme/icons/docker.svg";
import eslintIcon from "material-icon-theme/icons/eslint.svg";
import fileIcon from "material-icon-theme/icons/file.svg";
import folderIcon from "material-icon-theme/icons/folder.svg";
import folderAppIcon from "material-icon-theme/icons/folder-app.svg";
import folderAppOpenIcon from "material-icon-theme/icons/folder-app-open.svg";
import folderComponentsIcon from "material-icon-theme/icons/folder-components.svg";
import folderComponentsOpenIcon from "material-icon-theme/icons/folder-components-open.svg";
import folderConfigIcon from "material-icon-theme/icons/folder-config.svg";
import folderConfigOpenIcon from "material-icon-theme/icons/folder-config-open.svg";
import folderDocsIcon from "material-icon-theme/icons/folder-docs.svg";
import folderDocsOpenIcon from "material-icon-theme/icons/folder-docs-open.svg";
import folderGitIcon from "material-icon-theme/icons/folder-git.svg";
import folderGitOpenIcon from "material-icon-theme/icons/folder-git-open.svg";
import folderGithubIcon from "material-icon-theme/icons/folder-github.svg";
import folderGithubOpenIcon from "material-icon-theme/icons/folder-github-open.svg";
import folderHookIcon from "material-icon-theme/icons/folder-hook.svg";
import folderHookOpenIcon from "material-icon-theme/icons/folder-hook-open.svg";
import folderImagesIcon from "material-icon-theme/icons/folder-images.svg";
import folderImagesOpenIcon from "material-icon-theme/icons/folder-images-open.svg";
import folderLibIcon from "material-icon-theme/icons/folder-lib.svg";
import folderLibOpenIcon from "material-icon-theme/icons/folder-lib-open.svg";
import folderOpenIcon from "material-icon-theme/icons/folder-open.svg";
import folderPublicIcon from "material-icon-theme/icons/folder-public.svg";
import folderPublicOpenIcon from "material-icon-theme/icons/folder-public-open.svg";
import folderScriptsIcon from "material-icon-theme/icons/folder-scripts.svg";
import folderScriptsOpenIcon from "material-icon-theme/icons/folder-scripts-open.svg";
import folderServerIcon from "material-icon-theme/icons/folder-server.svg";
import folderServerOpenIcon from "material-icon-theme/icons/folder-server-open.svg";
import folderSrcIcon from "material-icon-theme/icons/folder-src.svg";
import folderSrcOpenIcon from "material-icon-theme/icons/folder-src-open.svg";
import folderSrcTauriIcon from "material-icon-theme/icons/folder-src-tauri.svg";
import folderSrcTauriOpenIcon from "material-icon-theme/icons/folder-src-tauri-open.svg";
import folderTestIcon from "material-icon-theme/icons/folder-test.svg";
import folderTestOpenIcon from "material-icon-theme/icons/folder-test-open.svg";
import goIcon from "material-icon-theme/icons/go.svg";
import htmlIcon from "material-icon-theme/icons/html.svg";
import imageIcon from "material-icon-theme/icons/image.svg";
import javaIcon from "material-icon-theme/icons/java.svg";
import javascriptIcon from "material-icon-theme/icons/javascript.svg";
import jsonIcon from "material-icon-theme/icons/json.svg";
import lockIcon from "material-icon-theme/icons/lock.svg";
import markdownIcon from "material-icon-theme/icons/markdown.svg";
import nextIcon from "material-icon-theme/icons/next.svg";
import nodejsIcon from "material-icon-theme/icons/nodejs.svg";
import npmIcon from "material-icon-theme/icons/npm.svg";
import prettierIcon from "material-icon-theme/icons/prettier.svg";
import pythonIcon from "material-icon-theme/icons/python.svg";
import reactIcon from "material-icon-theme/icons/react.svg";
import reactTsIcon from "material-icon-theme/icons/react_ts.svg";
import rustIcon from "material-icon-theme/icons/rust.svg";
import svgIcon from "material-icon-theme/icons/svg.svg";
import tailwindIcon from "material-icon-theme/icons/tailwindcss.svg";
import tomlIcon from "material-icon-theme/icons/toml.svg";
import tsconfigIcon from "material-icon-theme/icons/tsconfig.svg";
import typescriptIcon from "material-icon-theme/icons/typescript.svg";
import viteIcon from "material-icon-theme/icons/vite.svg";
import vitestIcon from "material-icon-theme/icons/vitest.svg";
import xmlIcon from "material-icon-theme/icons/xml.svg";
import yamlIcon from "material-icon-theme/icons/yaml.svg";
import { resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";

type IconAsset = string | { src: string };

type IconThemeManifest = {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  fileNames?: Record<string, string>;
  fileExtensions?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  rootFolderNames?: Record<string, string>;
  rootFolderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
};

export type WorkbenchIcon = {
  id: string;
  src: string;
  label: string;
};

const iconTheme = manifest as IconThemeManifest;

const ICON_ASSETS: Record<string, IconAsset> = {
  bun: bunIcon,
  c: cIcon,
  console: consoleIcon,
  cpp: cppIcon,
  css: cssIcon,
  database: databaseIcon,
  docker: dockerIcon,
  eslint: eslintIcon,
  file: fileIcon,
  folder: folderIcon,
  "folder-app": folderAppIcon,
  "folder-app-open": folderAppOpenIcon,
  "folder-components": folderComponentsIcon,
  "folder-components-open": folderComponentsOpenIcon,
  "folder-config": folderConfigIcon,
  "folder-config-open": folderConfigOpenIcon,
  "folder-docs": folderDocsIcon,
  "folder-docs-open": folderDocsOpenIcon,
  "folder-git": folderGitIcon,
  "folder-git-open": folderGitOpenIcon,
  "folder-github": folderGithubIcon,
  "folder-github-open": folderGithubOpenIcon,
  "folder-hook": folderHookIcon,
  "folder-hook-open": folderHookOpenIcon,
  "folder-images": folderImagesIcon,
  "folder-images-open": folderImagesOpenIcon,
  "folder-lib": folderLibIcon,
  "folder-lib-open": folderLibOpenIcon,
  "folder-open": folderOpenIcon,
  "folder-public": folderPublicIcon,
  "folder-public-open": folderPublicOpenIcon,
  "folder-scripts": folderScriptsIcon,
  "folder-scripts-open": folderScriptsOpenIcon,
  "folder-server": folderServerIcon,
  "folder-server-open": folderServerOpenIcon,
  "folder-src": folderSrcIcon,
  "folder-src-open": folderSrcOpenIcon,
  "folder-src-tauri": folderSrcTauriIcon,
  "folder-src-tauri-open": folderSrcTauriOpenIcon,
  "folder-test": folderTestIcon,
  "folder-test-open": folderTestOpenIcon,
  go: goIcon,
  html: htmlIcon,
  image: imageIcon,
  java: javaIcon,
  javascript: javascriptIcon,
  json: jsonIcon,
  lock: lockIcon,
  markdown: markdownIcon,
  next: nextIcon,
  nodejs: nodejsIcon,
  npm: npmIcon,
  prettier: prettierIcon,
  python: pythonIcon,
  react: reactIcon,
  react_ts: reactTsIcon,
  rust: rustIcon,
  svg: svgIcon,
  tailwindcss: tailwindIcon,
  toml: tomlIcon,
  tsconfig: tsconfigIcon,
  typescript: typescriptIcon,
  vite: viteIcon,
  vitest: vitestIcon,
  xml: xmlIcon,
  yaml: yamlIcon,
};

const FILE_EXTENSION_FALLBACKS: Record<string, string> = {
  cjs: "javascript",
  cts: "typescript",
  gif: "image",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  jsonc: "json",
  mdx: "markdown",
  mts: "typescript",
  png: "image",
  ts: "typescript",
  txt: "file",
  webp: "image",
  yml: "yaml",
};

const LANGUAGE_FALLBACKS: Record<string, string> = {
  javascript: "javascript",
  shell: "console",
  typescript: "typescript",
};

const FILE_NAME_FALLBACKS: Record<string, string> = {
  "bun.lock": "bun",
  "bun.lockb": "bun",
  dockerfile: "docker",
  "eslint.config.js": "eslint",
  "eslint.config.mjs": "eslint",
  "eslint.config.ts": "eslint",
  "next.config.js": "next",
  "next.config.mjs": "next",
  "next.config.ts": "next",
  "package-lock.json": "npm",
  "package.json": "nodejs",
  "pnpm-lock.yaml": "lock",
  "prettier.config.js": "prettier",
  "prettier.config.mjs": "prettier",
  "tailwind.config.js": "tailwindcss",
  "tailwind.config.ts": "tailwindcss",
  "tsconfig.json": "tsconfig",
  "vite.config.js": "vite",
  "vite.config.ts": "vite",
  "vitest.config.js": "vitest",
  "vitest.config.ts": "vitest",
  "yarn.lock": "lock",
};

function assetSource(asset: IconAsset): string {
  return typeof asset === "string" ? asset : asset.src;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function basename(path: string): string {
  return normalizePath(path).split("/").filter(Boolean).at(-1) ?? path;
}

function parentName(path: string): string | null {
  const segments = normalizePath(path).split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return segments[segments.length - 2]?.toLowerCase() ?? null;
}

function icon(id: string | null | undefined, fallbackId: "file" | "folder" | "folder-open", label: string): WorkbenchIcon {
  const resolvedId = id && ICON_ASSETS[id] ? id : fallbackId;
  return {
    id: resolvedId,
    src: assetSource(ICON_ASSETS[resolvedId]),
    label,
  };
}

function hasAsset(id: string | null | undefined): id is string {
  return Boolean(id && ICON_ASSETS[id]);
}

function iconForScopedAssociation(
  associations: Record<string, string> | undefined,
  path: string,
  name: string,
): string | null {
  if (!associations) return null;
  const parent = parentName(path);
  if (parent) {
    const scoped = associations[`${parent}/${name}`];
    if (scoped) return scoped;
  }
  return associations[name] ?? null;
}

function extensionCandidates(fileName: string): string[] {
  const parts = fileName.split(".");
  if (parts.length <= 1) return [];
  const startIndex = parts[0] === "" ? 1 : 1;
  const candidates: string[] = [];
  for (let index = startIndex; index < parts.length; index += 1) {
    const candidate = parts.slice(index).join(".");
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function resolveWorkbenchFileIcon(filePath: string): WorkbenchIcon {
  const fileName = basename(filePath).toLowerCase();
  const exactIcon = iconForScopedAssociation(iconTheme.fileNames, filePath, fileName)
    ?? FILE_NAME_FALLBACKS[fileName];
  if (hasAsset(exactIcon)) return icon(exactIcon, "file", "file");

  for (const extension of extensionCandidates(fileName)) {
    const scopedExtensionIcon = iconForScopedAssociation(iconTheme.fileExtensions, filePath, extension);
    const extensionIcon = scopedExtensionIcon ?? FILE_EXTENSION_FALLBACKS[extension];
    if (hasAsset(extensionIcon)) return icon(extensionIcon, "file", "file");
  }

  const language = resolveEditorLanguage(filePath);
  const languageIcon = iconTheme.languageIds?.[language] ?? LANGUAGE_FALLBACKS[language];
  return icon(languageIcon ?? iconTheme.file, "file", "file");
}

export function resolveWorkbenchFolderIcon(folderPath: string, expanded: boolean, root = false): WorkbenchIcon {
  const folderName = basename(folderPath).toLowerCase();
  const rootAssociations = expanded ? iconTheme.rootFolderNamesExpanded : iconTheme.rootFolderNames;
  const folderAssociations = expanded ? iconTheme.folderNamesExpanded : iconTheme.folderNames;
  const defaultId = root
    ? expanded ? iconTheme.rootFolderExpanded : iconTheme.rootFolder
    : expanded ? iconTheme.folderExpanded : iconTheme.folder;
  const fallbackId = expanded ? "folder-open" : "folder";
  const associatedId = root
    ? rootAssociations?.[folderName] ?? folderAssociations?.[folderName]
    : folderAssociations?.[folderName];

  return icon(associatedId ?? defaultId, fallbackId, "folder");
}
