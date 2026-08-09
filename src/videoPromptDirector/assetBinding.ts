/**
 * Provider-neutral asset field construction and route asset binding.
 * Extracted so compile stays orchestration-only.
 */

import type { GenerationRequest } from "../project/schema.js";
import type { H3Asset, H3CreativeIr, H3Mode } from "./schema.js";
import {
  H3_ASSET_BINDING_MISMATCH_CODE,
  type H3RouteModeBinding
} from "./validation/adapterRoute.js";
import { issue, type H3Issue } from "./validation/types.js";

export type NeutralAssetFields = {
  first_frame?: string;
  last_frame?: string;
  input_images?: string[];
  input_videos?: string[];
  input_audios?: string[];
};

export function buildAssetFields(ir: H3CreativeIr): NeutralAssetFields {
  switch (ir.target.mode) {
    case "text-to-video":
      return {};
    case "first-frame": {
      const first = ir.assets.find((asset) => asset.role === "first_frame" && asset.type === "image");
      return first ? { first_frame: first.path } : {};
    }
    case "first-last": {
      const first = ir.assets.find((asset) => asset.role === "first_frame" && asset.type === "image");
      const last = ir.assets.find((asset) => asset.role === "last_frame" && asset.type === "image");
      if (!first || !last) return {};
      return { first_frame: first.path, last_frame: last.path };
    }
    case "last-frame": {
      const last = ir.assets.find((asset) => asset.role === "last_frame" && asset.type === "image");
      return last ? { last_frame: last.path } : {};
    }
    case "reference": {
      const input_images = ir.assets.filter((asset) => asset.type === "image").map((asset) => asset.path);
      const input_videos = ir.assets.filter((asset) => asset.type === "video").map((asset) => asset.path);
      const input_audios = ir.assets.filter((asset) => asset.type === "audio").map((asset) => asset.path);
      return {
        ...(input_images.length > 0 ? { input_images } : {}),
        ...(input_videos.length > 0 ? { input_videos } : {}),
        ...(input_audios.length > 0 ? { input_audios } : {})
      };
    }
  }
}

export function applyAssetBinding(
  request: GenerationRequest,
  binding: H3RouteModeBinding
): { request: GenerationRequest; issues: H3Issue[] } {
  const issues: H3Issue[] = [];
  const base = { ...request };

  switch (binding.asset_binding) {
    case "none":
      return { request: base, issues };
    case "first_frame": {
      if (!base.first_frame) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires first_frame",
          "error",
          ["first_frame"]
        ));
      }
      return { request: base, issues };
    }
    case "last_frame": {
      if (!base.last_frame) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires last_frame",
          "error",
          ["last_frame"]
        ));
      }
      if (base.first_frame) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "last_frame binding must not include first_frame",
          "error",
          ["first_frame"]
        ));
      }
      return { request: base, issues };
    }
    case "first_and_last_frame": {
      if (!base.first_frame || !base.last_frame) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires first_frame and last_frame",
          "error",
          ["first_frame"]
        ));
      }
      return { request: base, issues };
    }
    case "first_last_as_input_images": {
      const first = base.first_frame;
      const last = base.last_frame;
      if (!first || !last) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires first_frame and last_frame to pack input_images",
          "error",
          ["first_frame"]
        ));
        return { request: base, issues };
      }
      const {
        first_frame: _first,
        last_frame: _last,
        ...rest
      } = base;
      return {
        request: {
          ...rest,
          input_images: [first, last]
        },
        issues
      };
    }
    case "reference_lists": {
      const hasMedia = Boolean(
        (base.input_images?.length ?? 0)
        + (base.input_videos?.length ?? 0)
        + (base.input_audios?.length ?? 0)
      );
      if (!hasMedia) {
        issues.push(issue(
          H3_ASSET_BINDING_MISMATCH_CODE,
          "route asset binding requires at least one reference media list",
          "error",
          ["input_images"]
        ));
      }
      return { request: base, issues };
    }
  }
}

export function assetIndex(ir: H3CreativeIr, asset: H3Asset): number {
  return ir.assets.findIndex((item) => item.id === asset.id);
}

export function exclusiveSemanticsForMode(mode: H3Mode): string[] {
  switch (mode) {
    case "last-frame":
      return ["last-frame-only", "l2va"];
    case "first-last":
      return ["fl2va"];
    default:
      return [];
  }
}
