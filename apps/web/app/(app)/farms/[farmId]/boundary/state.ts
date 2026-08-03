// Boundary-flow state shared between the server actions and the client
// component. Lives outside actions.ts because a "use server" module may only
// export async functions.

/** One candidate parcel, ready to render and to post back on selection. */
export interface ParcelCandidate {
  apn: string;
  /** "about 42 acres" — display string computed server-side. */
  acresLabel: string;
  /** GeoJSON (Multi)Polygon, serialized — posted back verbatim on select. */
  geojson: string;
}

export interface ParcelSearchState {
  status: "idle" | "results" | "empty" | "error";
  message: string;
  candidates: ParcelCandidate[];
}

export const initialParcelSearchState: ParcelSearchState = {
  status: "idle",
  message: "",
  candidates: [],
};

export interface SetBoundaryState {
  status: "idle" | "saved" | "error";
  message: string;
}

export const initialSetBoundaryState: SetBoundaryState = {
  status: "idle",
  message: "",
};

/** One building footprint found inside the boundary. */
export interface BuildingCandidate {
  /** GeoJSON Polygon, serialized — posted back verbatim on add. */
  geojson: string;
  /** OSM name tag when present (kept as a note; the map name is numbered). */
  osmName: string | null;
}

export interface FindBuildingsState {
  status: "idle" | "found" | "error";
  message: string;
  buildings: BuildingCandidate[];
}

export const initialFindBuildingsState: FindBuildingsState = {
  status: "idle",
  message: "",
  buildings: [],
};

export interface AddBuildingsState {
  status: "idle" | "added" | "error";
  message: string;
  imported: number;
  skipped: number;
}

export const initialAddBuildingsState: AddBuildingsState = {
  status: "idle",
  message: "",
  imported: 0,
  skipped: 0,
};
