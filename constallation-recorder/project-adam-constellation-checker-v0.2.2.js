import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./project-adam-config.js";

const VERSION = "0.2.2";
const GEOMETRY_VERSION = "open-path-6/v1";
const IMAGE_BUCKET = "constellation-images";
const ACTIVATION_EDGES = Object.freeze([[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]);

const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL)
  && !SUPABASE_PUBLISHABLE_KEY.includes("PASTE_");
const $ = selector => document.querySelector(selector);
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const loginForm = $("#login-form");
const signOutButton = $("#sign-out");
const characterSelect = $("#character");
const storedImageSelect = $("#stored-image");
const imageInput = $("#image-file");
const zoomSelect = $("#zoom");
const undoButton = $("#undo");
const clearButton = $("#clear");
const copyActivationButton = $("#copy-activation-edges");
const clearEdgesButton = $("#clear-edges");
const saveButton = $("#save");
const refreshButton = $("#refresh");
const heightInputs = [...document.querySelectorAll(".height")];

let supabase = null;
let signedInUser = null;
let image = null;
let imageBytes = null;
let imageName = "";
let imageMimeType = "";
let imageHash = null;
let imageId = null;
let storagePath = null;
let points = [];
let displayedEdges = [];
let categoryTags = [];
let editingMeasurementId = null;
let suppressCharacterChange = false;

function setStatus(selector, message, kind = "") {
  const element = $(selector);
  element.textContent = message;
  element.className = kind;
}

function round(value, places = 8) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function finiteNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function edgeKey(edge) {
  const [a, b] = edge[0] < edge[1] ? edge : [edge[1], edge[0]];
  return `${a}-${b}`;
}

function normalizedEdges(edges = displayedEdges) {
  const unique = new Map();
  for (const edge of edges) {
    const a = Number(edge?.[0]);
    const b = Number(edge?.[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || a > 6 || b < 1 || b > 6 || a === b) continue;
    const normalized = a < b ? [a, b] : [b, a];
    unique.set(edgeKey(normalized), normalized);
  }
  return [...unique.values()].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

function selectedLineFit() {
  return document.querySelector('input[name="line-fit"]:checked')?.value || "uncertain";
}

function normalizeTag(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizedTags(values = categoryTags) {
  const unique = new Set();
  for (const value of values) {
    const tag = normalizeTag(value);
    if (tag && tag.length <= 80) unique.add(tag);
    if (unique.size === 32) break;
  }
  return [...unique];
}

function tagsFromRecord(record) {
  if (Array.isArray(record.category_tags)) return normalizedTags(record.category_tags);
  return normalizedTags(String(record.category_label || "").split(","));
}

function legacyCategoryLabel() {
  return normalizedTags().join(", ").slice(0, 200);
}

function coordinateFrame() {
  const originX = finiteNumber($("#origin-x").value) ?? 0;
  const originY = finiteNumber($("#origin-y").value) ?? 0;
  const sourceWidth = finiteNumber($("#source-width").value);
  const sourceHeight = finiteNumber($("#source-height").value);
  return {
    local_origin: { x_px: 0, y_px: 0, anchor: "top_left" },
    local_axes: { x: "right", y: "down" },
    image_width_px: image ? canvas.width : null,
    image_height_px: image ? canvas.height : null,
    crop_origin_in_source_px: { x: round(originX), y: round(originY) },
    source_width_px: sourceWidth === null ? null : round(sourceWidth),
    source_height_px: sourceHeight === null ? null : round(sourceHeight)
  };
}

function heightValues() {
  return heightInputs.map(input => finiteNumber(input.value));
}

function storedPoints() {
  if (!image) return [];
  const frame = coordinateFrame();
  const heights = heightValues();
  const origin = frame.crop_origin_in_source_px;
  return points.map((point, index) => ({
    order: index + 1,
    x_px: round(point.x),
    y_px: round(point.y),
    x_norm: round(point.x / canvas.width),
    y_norm: round(point.y / canvas.height),
    source_x_px: round(origin.x + point.x),
    source_y_px: round(origin.y + point.y),
    height_z: heights[index]
  }));
}

function vectorsForPath(pathPoints) {
  const vectors = [];
  for (let index = 0; index < pathPoints.length - 1; index += 1) {
    vectors.push({
      dx: pathPoints[index + 1].x - pathPoints[index].x,
      dy: -(pathPoints[index + 1].y - pathPoints[index].y)
    });
  }
  return vectors;
}

function pathSignature(pointNumbers) {
  if (pointNumbers.some(number => !points[number - 1])) return null;
  const pathPoints = pointNumbers.map(number => points[number - 1]);
  const vectors = vectorsForPath(pathPoints);
  const lengths = vectors.map(vector => Math.hypot(vector.dx, vector.dy));
  const headings = vectors.map(vector => Math.atan2(vector.dy, vector.dx) * 180 / Math.PI);
  const turns = [];
  for (let index = 0; index < headings.length - 1; index += 1) {
    let turn = headings[index + 1] - headings[index];
    while (turn <= -180) turn += 360;
    while (turn > 180) turn -= 360;
    turns.push(turn);
  }
  return {
    points: pointNumbers,
    segment_lengths_px: lengths.map(value => round(value)),
    adjacent_length_ratios: lengths.slice(0, -1).map((value, index) => value > 0 ? round(lengths[index + 1] / value) : null),
    segment_headings_deg: headings.map(value => round(value)),
    signed_turn_degrees: turns.map(value => round(value))
  };
}

function geometrySignature() {
  const path = pathSignature([1, 2, 3, 4, 5, 6]);
  const lengths = path?.segment_lengths_px || [];
  const lengthMedian = median(lengths);
  const turns = path?.signed_turn_degrees || [];
  const turnSum = turns.reduce((sum, value) => sum + value, 0);
  return {
    coordinate_convention: "+x right; source +y down; turn calculations use +y up",
    path_mode: "open",
    point_count: points.length,
    segment_count: lengths.length,
    segment_lengths_px: lengths,
    segment_headings_deg: path?.segment_headings_deg || [],
    length_median_px: lengthMedian === null ? null : round(lengthMedian),
    segment_lengths_median_ratio: lengthMedian && lengthMedian > 0 ? lengths.map(value => round(value / lengthMedian)) : [],
    adjacent_length_ratios: path?.adjacent_length_ratios || [],
    signed_turn_degrees: turns,
    absolute_turn_degrees: turns.map(value => round(Math.abs(value))),
    total_signed_turn_degrees: round(turnSum),
    orientation: Math.abs(turnSum) < 1e-9 ? "balanced" : turnSum > 0 ? "counterclockwise" : "clockwise",
    alternating_paths: {
      odd_x_candidate: pathSignature([1, 3, 5]),
      even_y_candidate: pathSignature([2, 4, 6])
    }
  };
}

function angleBetweenAt(vertex, neighborA, neighborB) {
  const center = points[vertex - 1];
  const a = points[neighborA - 1];
  const b = points[neighborB - 1];
  if (!center || !a || !b) return null;
  const vectorA = { x: a.x - center.x, y: -(a.y - center.y) };
  const vectorB = { x: b.x - center.x, y: -(b.y - center.y) };
  const lengthA = Math.hypot(vectorA.x, vectorA.y);
  const lengthB = Math.hypot(vectorB.x, vectorB.y);
  if (!lengthA || !lengthB) return null;
  const cosine = Math.max(-1, Math.min(1, (vectorA.x * vectorB.x + vectorA.y * vectorB.y) / (lengthA * lengthB)));
  return Math.acos(cosine) * 180 / Math.PI;
}

function topologySignature() {
  const edges = normalizedEdges();
  const adjacency = Array.from({ length: 6 }, () => new Set());
  for (const [a, b] of edges) {
    adjacency[a - 1].add(b);
    adjacency[b - 1].add(a);
  }

  let components = 0;
  const visited = new Set();
  for (let start = 1; start <= 6; start += 1) {
    if (visited.has(start)) continue;
    components += 1;
    const stack = [start];
    while (stack.length) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbor of adjacency[current - 1]) stack.push(neighbor);
    }
  }

  let triangleCount = 0;
  for (let a = 1; a <= 4; a += 1) {
    for (let b = a + 1; b <= 5; b += 1) {
      for (let c = b + 1; c <= 6; c += 1) {
        if (adjacency[a - 1].has(b) && adjacency[b - 1].has(c) && adjacency[c - 1].has(a)) triangleCount += 1;
      }
    }
  }

  const edgeLengths = edges.map(([a, b]) => ({
    from: a,
    to: b,
    length_px: points.length === 6 ? Math.hypot(points[b - 1].x - points[a - 1].x, points[b - 1].y - points[a - 1].y) : null
  }));
  const measuredLengths = edgeLengths.map(edge => edge.length_px).filter(Number.isFinite);
  const graphMedian = median(measuredLengths);
  for (const edge of edgeLengths) {
    edge.length_px = edge.length_px === null ? null : round(edge.length_px);
    edge.median_ratio = edge.length_px !== null && graphMedian ? round(edge.length_px / graphMedian) : null;
  }

  const incidentAngles = [];
  for (let vertex = 1; vertex <= 6; vertex += 1) {
    const neighbors = [...adjacency[vertex - 1]].sort((a, b) => a - b);
    for (let left = 0; left < neighbors.length - 1; left += 1) {
      for (let right = left + 1; right < neighbors.length; right += 1) {
        const angle = angleBetweenAt(vertex, neighbors[left], neighbors[right]);
        incidentAngles.push({
          vertex,
          neighbor_a: neighbors[left],
          neighbor_b: neighbors[right],
          angle_deg: angle === null ? null : round(angle)
        });
      }
    }
  }

  const activationSet = new Set(ACTIVATION_EDGES.map(edgeKey));
  const displaySet = new Set(edges.map(edgeKey));
  const overlap = [...displaySet].filter(key => activationSet.has(key));
  return {
    node_count: 6,
    edge_count: edges.length,
    edges,
    degree_by_point: adjacency.map((neighbors, index) => ({ point: index + 1, degree: neighbors.size })),
    sorted_degree_sequence: adjacency.map(neighbors => neighbors.size).sort((a, b) => b - a),
    connected_components: components,
    cycle_rank: edges.length - 6 + components,
    triangle_count: triangleCount,
    branch_points: adjacency.map((neighbors, index) => neighbors.size >= 3 ? index + 1 : null).filter(Boolean),
    leaves: adjacency.map((neighbors, index) => neighbors.size === 1 ? index + 1 : null).filter(Boolean),
    activation_edge_overlap_count: overlap.length,
    activation_edges_missing_from_display: ACTIVATION_EDGES.filter(edge => !displaySet.has(edgeKey(edge))),
    displayed_edges_not_in_activation: edges.filter(edge => !activationSet.has(edgeKey(edge))),
    graph_edge_length_median_px: graphMedian === null ? null : round(graphMedian),
    graph_edges: edgeLengths,
    incident_angles: incidentAngles
  };
}

function heightMetadata() {
  const values = heightValues();
  const deltas = [];
  for (let index = 0; index < 5; index += 1) {
    deltas.push(values[index] === null || values[index + 1] === null ? null : round(values[index + 1] - values[index]));
  }
  const closureDelta = values[0] === null || values[5] === null ? null : round(values[0] - values[5]);
  const scale = finiteNumber($("#height-scale").value);
  const signature = geometrySignature();
  const correctedLengths = signature.segment_lengths_px.map((length, index) => {
    const delta = deltas[index];
    return scale && scale > 0 && delta !== null ? round(Math.hypot(length, delta * scale)) : null;
  });
  return {
    values,
    coordinate_system_or_unit: $("#height-system").value.trim() || null,
    open_path_deltas: deltas,
    p6_to_p1_closure_delta_diagnostic: closureDelta,
    pixels_per_height_unit: scale && scale > 0 ? scale : null,
    corrected_3d_segment_lengths_px: correctedLengths,
    note: "P6-to-P1 is stored only as a labeled closure diagnostic, not an observed path edge."
  };
}

function previewPayload() {
  const character = characterSelect.selectedOptions[0];
  return {
    format: "project-adam-constellation-measurement/v2",
    checker_version: VERSION,
    editing_measurement_id: editingMeasurementId,
    geometry_version: GEOMETRY_VERSION,
    character_id: characterSelect.value ? Number(characterSelect.value) : null,
    character_name: character?.dataset.name || null,
    image_id: imageId,
    image: {
      source_filename: imageName || null,
      source_mime_type: imageMimeType || null,
      source_image_sha256: imageHash,
      coordinate_frame: coordinateFrame(),
      source_status: $("#source-status").value,
      source_notes: $("#source-notes").value
    },
    points: storedPoints(),
    activation_signature: geometrySignature(),
    displayed_edges: normalizedEdges(),
    topology: topologySignature(),
    line_fit_class: selectedLineFit(),
    category_tags: normalizedTags(),
    category_label_legacy: legacyCategoryLabel(),
    height_metadata: heightMetadata(),
    notes: $("#notes").value
  };
}

function updateZoom() {
  const zoom = Number(zoomSelect.value);
  canvas.style.width = `${canvas.width * zoom}px`;
  canvas.style.height = `${canvas.height * zoom}px`;
}

function drawLine(from, to, color, dashed = false, width = 2) {
  if (!points[from - 1] || !points[to - 1]) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(width, canvas.width / 800);
  if (dashed) ctx.setLineDash([Math.max(6, canvas.width / 120), Math.max(4, canvas.width / 180)]);
  ctx.beginPath();
  ctx.moveTo(points[from - 1].x, points[from - 1].y);
  ctx.lineTo(points[to - 1].x, points[to - 1].y);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  else {
    ctx.fillStyle = "#11151d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#aab3c2";
    ctx.font = "20px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Load or paste a constellation image", canvas.width / 2, canvas.height / 2);
  }

  for (const [from, to] of normalizedEdges()) drawLine(from, to, "#5df2e6", false, 3);
  for (const [from, to] of ACTIVATION_EDGES) drawLine(from, to, "#ffd166", true, 2);

  points.forEach((point, index) => {
    const radius = Math.max(8, canvas.width / 110);
    ctx.fillStyle = "#35c2ff";
    ctx.strokeStyle = "#071019";
    ctx.lineWidth = Math.max(2, canvas.width / 900);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#071019";
    ctx.font = `700 ${Math.max(10, canvas.width / 90)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(index + 1), point.x, point.y);
  });
}

function renderEdgeControls() {
  const grid = $("#edge-grid");
  grid.replaceChildren();
  const edgeSet = new Set(normalizedEdges().map(edgeKey));
  for (let a = 1; a <= 5; a += 1) {
    for (let b = a + 1; b <= 6; b += 1) {
      const button = document.createElement("button");
      const key = edgeKey([a, b]);
      button.type = "button";
      button.textContent = `P${a}–P${b}`;
      button.disabled = points.length !== 6;
      button.classList.toggle("active", edgeSet.has(key));
      button.addEventListener("click", () => {
        if (edgeSet.has(key)) displayedEdges = normalizedEdges().filter(edge => edgeKey(edge) !== key);
        else displayedEdges = normalizedEdges([...displayedEdges, [a, b]]);
        render();
      });
      grid.append(button);
    }
  }
}

function renderTagControls() {
  const list = $("#tag-list");
  list.replaceChildren();
  if (!categoryTags.length) {
    list.append(Object.assign(document.createElement("span"), { textContent: "No tags added.", className: "muted" }));
    return;
  }
  for (const tag of normalizedTags()) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    const label = document.createElement("span");
    label.textContent = tag;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove tag ${tag}`);
    remove.addEventListener("click", () => {
      categoryTags = categoryTags.filter(value => value !== tag);
      setStatus("#tag-status", `Removed “${tag}”.`, "muted");
      render();
    });
    chip.append(label, remove);
    list.append(chip);
  }
}

function addTagsFromInput() {
  const input = $("#tag-input");
  const candidates = normalizedTags(input.value.split(","));
  if (!candidates.length) {
    setStatus("#tag-status", "Type a tag first.", "error");
    return;
  }
  const before = new Set(categoryTags);
  categoryTags = normalizedTags([...categoryTags, ...candidates]);
  input.value = "";
  if (categoryTags.length === before.size) setStatus("#tag-status", "Those tags were already present.", "muted");
  else if (categoryTags.length === 32) setStatus("#tag-status", "Tags added. The 32-tag limit has been reached.", "success");
  else setStatus("#tag-status", `Added ${categoryTags.length - before.size} tag(s).`, "success");
  render();
  input.focus();
}

function renderTables() {
  const pointRows = $("#point-rows");
  pointRows.replaceChildren();
  if (!points.length) pointRows.innerHTML = '<tr><td colspan="5" class="muted">No points</td></tr>';
  else {
    for (const point of storedPoints()) {
      const row = document.createElement("tr");
      row.innerHTML = `<td>P${point.order}</td><td>${point.x_px.toFixed(2)}</td><td>${point.y_px.toFixed(2)}</td><td>${point.source_x_px.toFixed(2)}</td><td>${point.source_y_px.toFixed(2)}</td>`;
      pointRows.append(row);
    }
  }

  const signature = geometrySignature();
  const segmentRows = $("#segment-rows");
  segmentRows.replaceChildren();
  if (!signature.segment_lengths_px.length) segmentRows.innerHTML = '<tr><td colspan="4" class="muted">Need two points</td></tr>';
  else signature.segment_lengths_px.forEach((length, index) => {
    const row = document.createElement("tr");
    const normalized = signature.segment_lengths_median_ratio[index];
    const ratio = signature.adjacent_length_ratios[index];
    row.innerHTML = `<td>P${index + 1}→P${index + 2}</td><td>${length.toFixed(3)}</td><td>${normalized?.toFixed(5) ?? "—"}</td><td>${ratio?.toFixed(5) ?? "—"}</td>`;
    segmentRows.append(row);
  });

  const turnRows = $("#turn-rows");
  turnRows.replaceChildren();
  if (!signature.signed_turn_degrees.length) turnRows.innerHTML = '<tr><td colspan="3" class="muted">Need three points</td></tr>';
  else signature.signed_turn_degrees.forEach((turn, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>P${index + 2}</td><td>${turn.toFixed(3)}°</td><td>${Math.abs(turn).toFixed(3)}°</td>`;
    turnRows.append(row);
  });

  const topology = topologySignature();
  $("#topology-summary").textContent = normalizedEdges().length ? JSON.stringify({
    edges: topology.edges,
    degree_sequence: topology.sorted_degree_sequence,
    branch_points: topology.branch_points,
    leaves: topology.leaves,
    cycles: topology.cycle_rank,
    triangles: topology.triangle_count,
    activation_overlap: topology.activation_edge_overlap_count,
    activation_edges_missing: topology.activation_edges_missing_from_display,
    extra_displayed_edges: topology.displayed_edges_not_in_activation
  }, null, 2) : "No visible edges selected.";
  $("#preview").textContent = JSON.stringify(previewPayload(), null, 2);

  undoButton.disabled = points.length === 0;
  clearButton.disabled = points.length === 0;
  copyActivationButton.disabled = points.length !== 6;
  clearEdgesButton.disabled = displayedEdges.length === 0;
  const ready = Boolean(signedInUser && image && points.length === 6 && characterSelect.value && displayedEdges.length > 0);
  saveButton.disabled = !ready;
  setStatus("#point-status", image
    ? points.length < 6
      ? `${points.length}/6 points recorded. Click P${points.length + 1}.`
      : displayedEdges.length
        ? `6/6 points and ${displayedEdges.length} visible line(s) recorded.`
        : "6/6 points recorded. Add the visible constellation lines."
    : "Load an image, then click P1.", points.length === 6 && displayedEdges.length ? "success" : "");
}

function render() {
  draw();
  renderEdgeControls();
  renderTagControls();
  renderTables();
}

function resetAnnotation({ keepImage = true } = {}) {
  points = [];
  displayedEdges = [];
  categoryTags = [];
  editingMeasurementId = null;
  heightInputs.forEach(input => { input.value = ""; });
  $("#height-system").value = "";
  $("#height-scale").value = "";
  $("#tag-input").value = "";
  $("#notes").value = "";
  document.querySelector('input[name="line-fit"][value="uncertain"]').checked = true;
  if (!keepImage) {
    image = null;
    imageBytes = null;
    imageName = "";
    imageMimeType = "";
    imageHash = null;
    imageId = null;
    storagePath = null;
    canvas.width = 900;
    canvas.height = 560;
    updateZoom();
    setStatus("#image-status", "No image loaded.");
  }
  setStatus("#edit-status", "New measurement. Loading an existing record makes Save overwrite that row.", "muted");
  setStatus("#save-status", "Complete the measurement, then save.");
  setStatus("#tag-status", "Add up to 32 tags. Tags are stored in lowercase so exact matches remain consistent.", "muted");
  render();
}

function applyCoordinateFrame(frame = {}) {
  const origin = frame.crop_origin_in_source_px || {};
  $("#origin-x").value = finiteNumber(origin.x) ?? 0;
  $("#origin-y").value = finiteNumber(origin.y) ?? 0;
  $("#source-width").value = finiteNumber(frame.source_width_px) ?? "";
  $("#source-height").value = finiteNumber(frame.source_height_px) ?? "";
}

async function decodeImageBlob(blob) {
  const objectUrl = URL.createObjectURL(blob);
  const nextImage = new Image();
  try {
    await new Promise((resolve, reject) => {
      nextImage.onload = resolve;
      nextImage.onerror = () => reject(new Error("The browser could not decode that image."));
      nextImage.src = objectUrl;
    });
    return nextImage;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function useImageBlob(blob, metadata, { reset = true } = {}) {
  const decoded = await decodeImageBlob(blob);
  image = decoded;
  imageBytes = await blob.arrayBuffer();
  imageName = metadata.original_filename || metadata.name || "constellation-image";
  imageMimeType = metadata.mime_type || blob.type;
  imageHash = metadata.sha256 || await sha256Hex(imageBytes);
  imageId = metadata.id ?? null;
  storagePath = metadata.storage_path ?? null;
  canvas.width = decoded.naturalWidth;
  canvas.height = decoded.naturalHeight;
  applyCoordinateFrame(metadata.coordinate_frame || {});
  $("#source-status").value = metadata.source_status || "released";
  $("#source-notes").value = metadata.source_notes || "";
  updateZoom();
  if (reset) resetAnnotation({ keepImage: true });
  setStatus("#image-status", `${imageName} · ${canvas.width}×${canvas.height} · ${imageId ? `stored image ${imageId}` : "new image"} · SHA-256 ${imageHash.slice(0, 12)}…`, "success");
  render();
}

async function loadLocalImage(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
    setStatus("#image-status", "Choose a PNG, JPEG, WebP, or GIF image.", "error");
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    setStatus("#image-status", "The image exceeds the 25 MiB storage limit.", "error");
    return;
  }
  try {
    await useImageBlob(file, {
      name: file.name,
      mime_type: file.type,
      source_status: $("#source-status").value,
      coordinate_frame: { crop_origin_in_source_px: { x: 0, y: 0 } }
    });
    storedImageSelect.value = "";
  } catch (error) {
    setStatus("#image-status", error.message, "error");
  }
}

async function loadCharacters() {
  characterSelect.disabled = true;
  characterSelect.innerHTML = '<option value="">Loading characters…</option>';
  const { data, error } = await supabase.from("characters").select("avatar_id, name, element_attr_id").order("name");
  if (error) {
    characterSelect.innerHTML = '<option value="">Could not load characters</option>';
    setStatus("#save-status", `Character load failed: ${error.message}`, "error");
    return;
  }
  characterSelect.replaceChildren(new Option("Select a character…", ""));
  for (const character of data) {
    const option = new Option(`${character.name} · ${character.avatar_id}`, String(character.avatar_id));
    option.dataset.name = character.name;
    option.dataset.elementAttrId = character.element_attr_id ?? "";
    characterSelect.append(option);
  }
  characterSelect.disabled = false;
  if (!data.length) setStatus("#save-status", "No normalized characters found. Upload the catalog and rerun schema v1.", "error");
}

async function loadStoredImages() {
  storedImageSelect.disabled = true;
  storedImageSelect.replaceChildren(new Option(characterSelect.value ? "Loading stored images…" : "Select a character first", ""));
  if (!characterSelect.value) return;
  const { data, error } = await supabase
    .from("constellation_images")
    .select("id, original_filename, source_status, updated_at")
    .eq("character_id", Number(characterSelect.value))
    .order("updated_at", { ascending: false });
  if (error) {
    setStatus("#image-status", `Stored-image list failed: ${error.message}`, "error");
    return;
  }
  storedImageSelect.replaceChildren(new Option("Upload/paste a new image…", ""));
  for (const record of data) {
    storedImageSelect.append(new Option(`${record.original_filename} · ${record.source_status} · image ${record.id}`, String(record.id)));
  }
  storedImageSelect.disabled = false;
}

async function fetchImageRecord(id) {
  const { data, error } = await supabase.from("constellation_images").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data;
}

async function loadStoredImage(id, { reset = true } = {}) {
  if (!id) return;
  setStatus("#image-status", "Downloading private image…");
  try {
    const record = await fetchImageRecord(Number(id));
    const { data: blob, error } = await supabase.storage.from(record.storage_bucket).download(record.storage_path);
    if (error) throw new Error(error.message);
    await useImageBlob(blob, record, { reset });
    storedImageSelect.value = String(record.id);
  } catch (error) {
    setStatus("#image-status", `Image load failed: ${error.message}`, "error");
    throw error;
  }
}

async function loadMeasurements() {
  const list = $("#measurements");
  list.innerHTML = '<li class="muted">Loading…</li>';
  const { data, error } = await supabase
    .from("constellation_measurements")
    .select("id, image_id, updated_at, character_id, source_filename, line_fit_class, category_label, category_tags, characters(name)")
    .order("updated_at", { ascending: false })
    .limit(40);
  list.replaceChildren();
  if (error) {
    list.append(Object.assign(document.createElement("li"), { textContent: error.message, className: "error" }));
    return;
  }
  if (!data.length) {
    list.append(Object.assign(document.createElement("li"), { textContent: "No measurements saved yet.", className: "muted" }));
    return;
  }
  for (const measurement of data) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    const tags = tagsFromRecord(measurement);
    text.textContent = `${measurement.characters?.name || measurement.character_id} · ${tags.length ? tags.join(" + ") : "no tags"} · ${measurement.line_fit_class} · ${measurement.source_filename} · ${new Date(measurement.updated_at).toLocaleString()}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "measurement-load";
    button.textContent = "Load/edit";
    button.disabled = !measurement.image_id;
    if (!measurement.image_id) button.title = "This older record has no stored image.";
    button.addEventListener("click", () => loadMeasurement(measurement.id));
    item.append(text, button);
    list.append(item);
  }
}

async function loadMeasurement(id) {
  setStatus("#save-status", `Loading measurement ${id}…`);
  const { data, error } = await supabase.from("constellation_measurements").select("*").eq("id", id).single();
  if (error) {
    setStatus("#save-status", `Load failed: ${error.message}`, "error");
    return;
  }
  if (!data.image_id) {
    setStatus("#save-status", "This older measurement has no stored image and cannot yet be redrawn.", "error");
    return;
  }
  suppressCharacterChange = true;
  characterSelect.value = String(data.character_id);
  suppressCharacterChange = false;
  await loadStoredImages();
  await loadStoredImage(data.image_id, { reset: false });
  points = (data.points || []).slice(0, 6).map(point => ({ x: Number(point.x_px), y: Number(point.y_px) }));
  displayedEdges = normalizedEdges(data.displayed_edges || []);
  const values = data.height_metadata?.values || (data.points || []).map(point => point.height_z ?? null);
  heightInputs.forEach((input, index) => { input.value = finiteNumber(values[index]) ?? ""; });
  $("#height-system").value = data.height_metadata?.coordinate_system_or_unit || "";
  $("#height-scale").value = finiteNumber(data.height_metadata?.pixels_per_height_unit) ?? "";
  categoryTags = tagsFromRecord(data);
  $("#tag-input").value = "";
  $("#notes").value = data.notes || "";
  const lineFit = document.querySelector(`input[name="line-fit"][value="${data.line_fit_class || 'uncertain'}"]`);
  if (lineFit) lineFit.checked = true;
  editingMeasurementId = data.id;
  setStatus("#edit-status", `Editing measurement ${data.id}. Save will overwrite this row; created_at remains unchanged.`, "success");
  setStatus("#save-status", "Loaded. Make changes and save.");
  render();
}

function imageExtension(mimeType) {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" })[mimeType] || "bin";
}

function imageMetadataRow() {
  return {
    character_id: Number(characterSelect.value),
    storage_bucket: IMAGE_BUCKET,
    storage_path: storagePath,
    sha256: imageHash,
    original_filename: imageName.slice(0, 255),
    mime_type: imageMimeType,
    width: canvas.width,
    height: canvas.height,
    coordinate_frame: coordinateFrame(),
    source_status: $("#source-status").value,
    source_notes: $("#source-notes").value
  };
}

async function ensureImageRecord() {
  if (!image || !imageHash || !imageBytes) throw new Error("No image is loaded.");
  if (imageId) {
    const row = imageMetadataRow();
    const { data, error } = await supabase.from("constellation_images").update(row).eq("id", imageId).select("id, storage_path").single();
    if (error) throw new Error(`Image metadata update failed: ${error.message}`);
    storagePath = data.storage_path;
    return data.id;
  }

  const { data: existing, error: lookupError } = await supabase
    .from("constellation_images")
    .select("id, storage_path")
    .eq("sha256", imageHash)
    .eq("character_id", Number(characterSelect.value))
    .maybeSingle();
  if (lookupError) throw new Error(`Image duplicate check failed: ${lookupError.message}`);
  if (existing) {
    imageId = existing.id;
    storagePath = existing.storage_path;
    return ensureImageRecord();
  }

  storagePath = `${signedInUser.id}/${characterSelect.value}/${imageHash}.${imageExtension(imageMimeType)}`;
  const blob = new Blob([imageBytes], { type: imageMimeType });
  const { error: uploadError } = await supabase.storage.from(IMAGE_BUCKET).upload(storagePath, blob, {
    contentType: imageMimeType,
    upsert: false,
    cacheControl: "3600"
  });
  if (uploadError) throw new Error(`Private image upload failed: ${uploadError.message}`);

  const row = imageMetadataRow();
  const { data, error } = await supabase.from("constellation_images").insert(row).select("id").single();
  if (error) {
    await supabase.storage.from(IMAGE_BUCKET).remove([storagePath]);
    storagePath = null;
    throw new Error(`Image metadata save failed: ${error.message}`);
  }
  imageId = data.id;
  await loadStoredImages();
  storedImageSelect.value = String(imageId);
  return imageId;
}

async function measurementHash() {
  const identity = {
    geometry_version: GEOMETRY_VERSION,
    character_id: Number(characterSelect.value),
    source_image_sha256: imageHash,
    coordinate_frame: coordinateFrame(),
    points: storedPoints(),
    displayed_edges: normalizedEdges(),
    line_fit_class: selectedLineFit(),
    category_tags: normalizedTags(),
    height_metadata: heightMetadata(),
    notes: $("#notes").value
  };
  return sha256Hex(new TextEncoder().encode(JSON.stringify(identity)));
}

function measurementRow(savedImageId, hash) {
  return {
    image_id: savedImageId,
    annotation_version: VERSION,
    character_id: Number(characterSelect.value),
    geometry_version: GEOMETRY_VERSION,
    source_filename: imageName.slice(0, 255),
    source_mime_type: imageMimeType,
    source_image_sha256: imageHash,
    image_width: canvas.width,
    image_height: canvas.height,
    points: storedPoints(),
    signature: geometrySignature(),
    displayed_edges: normalizedEdges(),
    topology: topologySignature(),
    height_metadata: heightMetadata(),
    line_fit_class: selectedLineFit(),
    category_tags: normalizedTags(),
    category_label: legacyCategoryLabel(),
    measurement_sha256: hash,
    notes: $("#notes").value
  };
}

function setSignedIn(user) {
  signedInUser = user;
  const signedIn = Boolean(user);
  signOutButton.hidden = !signedIn;
  loginForm.querySelector('button[type="submit"]').disabled = signedIn;
  loginForm.email.disabled = signedIn;
  loginForm.password.disabled = signedIn;
  refreshButton.disabled = !signedIn;
  setStatus("#auth-status", signedIn ? `Signed in as ${user.email}.` : "Not signed in.", signedIn ? "success" : "");
  if (!signedIn) {
    characterSelect.disabled = true;
    characterSelect.innerHTML = '<option value="">Sign in to load characters</option>';
    storedImageSelect.disabled = true;
    storedImageSelect.innerHTML = '<option value="">Sign in first</option>';
    $("#measurements").innerHTML = '<li class="muted">Sign in to load measurements.</li>';
  }
  render();
}

canvas.addEventListener("click", event => {
  if (!image || points.length >= 6) return;
  const rect = canvas.getBoundingClientRect();
  points.push({
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height
  });
  render();
});

imageInput.addEventListener("change", () => loadLocalImage(imageInput.files?.[0]));
window.addEventListener("paste", event => {
  const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith("image/"));
  if (file) loadLocalImage(file);
});
zoomSelect.addEventListener("change", updateZoom);
storedImageSelect.addEventListener("change", () => {
  if (storedImageSelect.value) loadStoredImage(Number(storedImageSelect.value));
});
characterSelect.addEventListener("change", async () => {
  if (suppressCharacterChange) return;
  resetAnnotation({ keepImage: false });
  await loadStoredImages();
});
undoButton.addEventListener("click", () => { points.pop(); displayedEdges = []; render(); });
clearButton.addEventListener("click", () => { points = []; displayedEdges = []; render(); });
copyActivationButton.addEventListener("click", () => { displayedEdges = normalizedEdges(ACTIVATION_EDGES); render(); });
clearEdgesButton.addEventListener("click", () => { displayedEdges = []; render(); });
$("#add-tag").addEventListener("click", addTagsFromInput);
$("#tag-input").addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addTagsFromInput();
});
$("#new-measurement").addEventListener("click", () => resetAnnotation({ keepImage: true }));
refreshButton.addEventListener("click", loadMeasurements);

for (const selector of [
  "#origin-x", "#origin-y", "#source-width", "#source-height", "#source-status", "#source-notes",
  "#height-system", "#height-scale", "#notes"
]) $(selector).addEventListener("input", renderTables);
for (const input of heightInputs) input.addEventListener("input", renderTables);
for (const input of document.querySelectorAll('input[name="line-fit"]')) input.addEventListener("change", renderTables);

saveButton.addEventListener("click", async () => {
  if (!signedInUser || !image || points.length !== 6 || !characterSelect.value || !displayedEdges.length) return;
  saveButton.disabled = true;
  setStatus("#save-status", imageId ? "Saving…" : "Uploading private image and saving…");
  try {
    const savedImageId = await ensureImageRecord();
    const hash = await measurementHash();
    const row = measurementRow(savedImageId, hash);
    let result;
    if (editingMeasurementId) {
      result = await supabase.from("constellation_measurements").update(row).eq("id", editingMeasurementId).select("id, updated_at").single();
    } else {
      result = await supabase.from("constellation_measurements").insert(row).select("id, updated_at").single();
    }
    if (result.error?.code === "23505") throw new Error("An identical measurement is already stored.");
    if (result.error) throw new Error(result.error.message);
    const wasUpdate = Boolean(editingMeasurementId);
    editingMeasurementId = result.data.id;
    setStatus("#edit-status", `Editing measurement ${result.data.id}. Save will overwrite this row; created_at remains unchanged.`, "success");
    setStatus("#save-status", wasUpdate ? `Measurement ${result.data.id} updated successfully.` : `Measurement ${result.data.id} created successfully.`, "success");
    await loadMeasurements();
  } catch (error) {
    setStatus("#save-status", `Save failed: ${error.message}`, "error");
  } finally {
    renderTables();
  }
});

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!supabase) return;
  setStatus("#auth-status", "Signing in…");
  const form = new FormData(loginForm);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(form.get("email")),
    password: String(form.get("password"))
  });
  loginForm.password.value = "";
  if (error) {
    setSignedIn(null);
    setStatus("#auth-status", `Sign-in failed: ${error.message}`, "error");
    return;
  }
  setSignedIn(data.user);
  await Promise.all([loadCharacters(), loadMeasurements()]);
});

signOutButton.addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) setStatus("#auth-status", `Sign-out failed: ${error.message}`, "error");
});

if (!configured) {
  $("#setup-panel").hidden = false;
  setStatus("#auth-status", "The shared project configuration is missing or invalid.", "error");
  loginForm.querySelector('button[type="submit"]').disabled = true;
} else {
  $("#setup-panel").hidden = true;
  supabase = createClient(SUPABASE_URL.replace(/\/$/, ""), SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  const { data: { session } } = await supabase.auth.getSession();
  setSignedIn(session?.user ?? null);
  if (session?.user) await Promise.all([loadCharacters(), loadMeasurements()]);
  supabase.auth.onAuthStateChange((_event, session) => setSignedIn(session?.user ?? null));
}

updateZoom();
render();
