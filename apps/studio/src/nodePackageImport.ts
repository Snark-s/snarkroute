export const NODE_PACKAGE_PREVIEW_PATH = "/api/node-packages/preview";
export const NODE_PACKAGE_INSTALL_PATH = "/api/node-packages/install";

export type NodePackageSummary = {
  id: string;
  origin?: string;
};

export type NodePackageFilePayload = {
  filename: string;
  fileName: string;
  text?: string;
  dataBase64?: string;
};

export function canImportNodePackageFilename(filename: string): boolean {
  return /\.snarknode$/i.test(filename) || /\.node\.json$/i.test(filename) || /\.json$/i.test(filename);
}

export async function readNodePackageFilePayload(file: File): Promise<NodePackageFilePayload> {
  const isArchive = /\.snarknode$/i.test(file.name);
  return {
    filename: file.name,
    fileName: file.name,
    text: isArchive ? "" : await file.text(),
    dataBase64: isArchive ? await fileToBase64(file) : undefined
  };
}

export function canUninstallNodePackage(node: NodePackageSummary): boolean {
  return node.origin !== "bundled";
}

export function nodePackageIsUsedInRoute(nodeId: string, routeNodes: Array<{ type: string }>): boolean {
  return routeNodes.some((node) => node.type === nodeId);
}

export function uninstallNodeConfirmationMessage(nodeId: string, isUsedInCurrentRoute: boolean): string {
  if (isUsedInCurrentRoute) {
    return `This node is used in the current route. If you uninstall it, existing instances will become missing-node placeholders.\n\nUninstall local node "${nodeId}"?`;
  }
  return `Uninstall local node "${nodeId}"? Existing route files and current canvas instances will not be deleted.`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      resolve(text.includes(",") ? text.split(",")[1] : text);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}
