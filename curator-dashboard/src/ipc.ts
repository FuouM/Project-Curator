import { invoke } from "@tauri-apps/api/core";
import { create, fromBinary, toBinary, type Message, type MessageInitShape } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { logJS } from "./utils";
import { RescanSafetyResultSchema, SafetyRescanProgressSchema, RescanSafetyResult, SafetyRescanProgress } from "./gen/import_pb";

/**
 * Invoke a typed protobuf gRPC method over the shared Named Pipe bridge.
 *
 * `method` uses the `Service.Method` routing convention (e.g. `SystemService.GetStatus`).
 * The request is encoded to the protobuf binary wire format with `toBinary` and the
 * response is decoded with `fromBinary`, so both ends are fully type-checked.
 *
 * @param method    Routing key used by `src-tauri/src/typed_bridge.rs`.
 * @param reqSchema Generated schema for the request message, or `null` when the
 *                  RPC takes `google.protobuf.Empty`.
 * @param req       Partial request message, or `null`/`undefined` for an empty request.
 * @param respSchema Generated schema for the response message.
 */
export async function typedCall<Resp extends Message, Req extends Message = Message>(
  method: string,
  reqSchema: GenMessage<Req> | null,
  req: MessageInitShape<GenMessage<Req>> | null | undefined,
  respSchema: GenMessage<Resp>,
): Promise<Resp> {
  let requestBytes: Uint8Array;
  if (reqSchema && req) {
    requestBytes = toBinary(reqSchema, create(reqSchema, req));
  } else {
    requestBytes = new Uint8Array(0);
  }

  try {
    const resp = await invoke<ArrayBuffer | Uint8Array | number[]>("send_to_service_typed", {
      method,
      requestBytes,
    });
    const bytes = resp instanceof Uint8Array ? resp : new Uint8Array(resp);
    return fromBinary(respSchema, bytes);
  } catch (err: any) {
    logJS(`typedCall ${method} exception: ` + (err.message || err));
    throw err;
  }
}

export async function triggerSafetyRescan(): Promise<RescanSafetyResult> {
  return typedCall("ImportService.RescanSafety", null, null, RescanSafetyResultSchema);
}

export async function getSafetyRescanProgress(): Promise<SafetyRescanProgress> {
  return typedCall("ImportService.GetSafetyRescanProgress", null, null, SafetyRescanProgressSchema);
}
