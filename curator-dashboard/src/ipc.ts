import { invoke } from "@tauri-apps/api/core";
import { logJS } from "./utils";

export async function callService(request: any): Promise<any> {
  let formattedReq: any = request;

  if (request && typeof request === "object") {
    const keys = Object.keys(request);
    if (keys.length === 1) {
      const key = keys[0];
      const val = request[key];
      if (val === null || val === undefined) {
        formattedReq = key;
      } else {
        formattedReq = { [key]: val };
      }
    }
  }

  try {
    const jsonStr = JSON.stringify(formattedReq);
    const respStr: string = await invoke("send_to_service", { requestJson: jsonStr });
    const parsed = JSON.parse(respStr);
    if (typeof parsed === "string") {
      return { [parsed]: null };
    }
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
    throw new Error("Unknown response format: " + respStr);
  } catch (err: any) {
    logJS("callService exception: " + (err.message || err));
    throw err;
  }
}
