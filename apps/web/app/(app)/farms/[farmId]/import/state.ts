// Import-flow state shared between the server actions and the client
// component. Lives outside actions.ts because a "use server" module may only
// export async functions.
import type { FeatureKind, KmlGeometryType } from "@overwatch/db";

export interface ReviewFeature {
  name: string;
  kind: FeatureKind;
  restrictions: string | null;
  notes: string | null;
  geometryType: KmlGeometryType;
}

export interface ImportState {
  stage: "choose" | "review" | "done";
  message: string;
  fileName: string;
  /** Original KML text, echoed into the review form for step 2. */
  kml: string;
  features: ReviewFeature[];
  imported: number;
  skipped: string[];
}

export const initialImportState: ImportState = {
  stage: "choose",
  message: "",
  fileName: "",
  kml: "",
  features: [],
  imported: 0,
  skipped: [],
};
