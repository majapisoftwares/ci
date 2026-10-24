export type StackType = "static" | "container" | "none";

export interface DetectedStack {
  type: StackType;
  framework: string;
  details: string;
  buildDir: string;
}

export declare const DETECTION_FILES: readonly string[];
export declare function detectStack(
  read: (path: string) => Promise<string | null>,
  listRoot: () => Promise<string[]>,
): Promise<DetectedStack>;
export declare function readFromDirectory(root: string): (path: string) => Promise<string | null>;
export declare function listDirectory(root: string): () => Promise<string[]>;
