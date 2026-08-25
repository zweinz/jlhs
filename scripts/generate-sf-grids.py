"""Generate compact, no-runtime-API grids for SF elevation and nearest streets.

Inputs are deliberately explicit snapshots in /private/tmp:
  sf-terrain/{x}-{y}.png  Mapzen Terrarium z13 tiles
  sf-streets.geojson      DataSF Streets – Active and Retired

Run with the bundled Codex Python (Pillow is required), or any Python with Pillow.
"""

import json
import math
from pathlib import Path
from PIL import Image

WEST, SOUTH, EAST, NORTH = -122.53, 37.7, -122.35, 37.84
WIDTH, HEIGHT = 180, 140
ZOOM = 13
TERRAIN_DIR = Path('/private/tmp/sf-terrain')
STREETS_PATH = Path('/private/tmp/sf-streets.geojson')
OUTPUT_DIR = Path('src/data')


def cell_center(column, row):
    return (
        WEST + (column + 0.5) * (EAST - WEST) / WIDTH,
        SOUTH + (row + 0.5) * (NORTH - SOUTH) / HEIGHT,
    )


tile_cache = {}


def elevation_feet(lng, lat):
    scale = 2 ** ZOOM
    global_x = (lng + 180) / 360 * scale
    latitude_radians = math.radians(lat)
    global_y = (1 - math.asinh(math.tan(latitude_radians)) / math.pi) / 2 * scale
    tile_x, tile_y = math.floor(global_x), math.floor(global_y)
    key = (tile_x, tile_y)
    if key not in tile_cache:
        tile_cache[key] = Image.open(TERRAIN_DIR / f'{tile_x}-{tile_y}.png').convert('RGB')
    pixel_x = min(255, max(0, int((global_x - tile_x) * 256)))
    pixel_y = min(255, max(0, int((global_y - tile_y) * 256)))
    red, green, blue = tile_cache[key].getpixel((pixel_x, pixel_y))
    meters = red * 256 + green + blue / 256 - 32768
    return round(meters * 3.28084)


elevations = [
    elevation_feet(*cell_center(column, row))
    for row in range(HEIGHT)
    for column in range(WIDTH)
]

elevation_output = {
    'provenance': {
        'dataset': 'Mapzen Terrain Tiles on AWS',
        'sourceUrl': 'https://registry.opendata.aws/terrain-tiles/',
        'retrieved': '2026-08-24',
        'format': 'Terrarium z13; decoded to feet and sampled at approximately 300-foot cells',
    },
    'bounds': {'west': WEST, 'south': SOUTH, 'east': EAST, 'north': NORTH},
    'width': WIDTH,
    'height': HEIGHT,
    'valuesFeet': elevations,
}


with STREETS_PATH.open() as source:
    streets_geojson = json.load(source)

cosine = math.cos(math.radians((SOUTH + NORTH) / 2))
segments = []
for feature in streets_geojson['features']:
    properties = feature.get('properties', {})
    if not properties.get('active', False):
        continue
    name = properties.get('streetname') or ' '.join(
        value for value in [properties.get('street'), properties.get('st_type')] if value
    )
    coordinates = feature.get('geometry', {}).get('coordinates', [])
    if not name or len(coordinates) < 2:
        continue
    for start, end in zip(coordinates, coordinates[1:]):
        if max(start[0], end[0]) < WEST or min(start[0], end[0]) > EAST or max(start[1], end[1]) < SOUTH or min(start[1], end[1]) > NORTH:
            continue
        segments.append((start[0] * cosine, start[1], end[0] * cosine, end[1], name))

bucket_size = 0.005
buckets = {}
for index, (ax, ay, bx, by, _name) in enumerate(segments):
    min_x = math.floor((min(ax, bx) - WEST * cosine) / bucket_size) - 1
    max_x = math.floor((max(ax, bx) - WEST * cosine) / bucket_size) + 1
    min_y = math.floor((min(ay, by) - SOUTH) / bucket_size) - 1
    max_y = math.floor((max(ay, by) - SOUTH) / bucket_size) + 1
    for bucket_x in range(min_x, max_x + 1):
        for bucket_y in range(min_y, max_y + 1):
            buckets.setdefault((bucket_x, bucket_y), []).append(index)


def point_segment_distance_squared(px, py, segment):
    ax, ay, bx, by, _name = segment
    dx, dy = bx - ax, by - ay
    denominator = dx * dx + dy * dy
    if denominator == 0:
        return (px - ax) ** 2 + (py - ay) ** 2
    amount = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / denominator))
    nearest_x, nearest_y = ax + amount * dx, ay + amount * dy
    return (px - nearest_x) ** 2 + (py - nearest_y) ** 2


nearest_names = []
nearest_bearings = []
for row in range(HEIGHT):
    for column in range(WIDTH):
        lng, lat = cell_center(column, row)
        px = lng * cosine
        bucket_x = math.floor((px - WEST * cosine) / bucket_size)
        bucket_y = math.floor((lat - SOUTH) / bucket_size)
        candidates = set()
        for offset_x in range(-1, 2):
            for offset_y in range(-1, 2):
                candidates.update(buckets.get((bucket_x + offset_x, bucket_y + offset_y), []))
        if not candidates:
            nearest_names.append('Unknown')
            nearest_bearings.append(None)
            continue
        nearest_index = min(candidates, key=lambda index: point_segment_distance_squared(px, lat, segments[index]))
        ax, ay, bx, by, name = segments[nearest_index]
        nearest_names.append(name)
        # Axial degrees clockwise from north. A street has no forward direction,
        # so opposite headings intentionally collapse to the same 0-179 value.
        nearest_bearings.append(round(math.degrees(math.atan2(bx - ax, by - ay))) % 180)

street_names = sorted(set(nearest_names))
street_indexes = {name: index for index, name in enumerate(street_names)}
street_output = {
    'provenance': {
        'dataset': 'Streets – Active and Retired (active records only)',
        'sourceUrl': 'https://data.sfgov.org/d/3psu-pn9h',
        'retrieved': '2026-08-24',
        'format': 'Nearest named centerline and axial bearing sampled at approximately 300-foot cells',
    },
    'bounds': {'west': WEST, 'south': SOUTH, 'east': EAST, 'north': NORTH},
    'width': WIDTH,
    'height': HEIGHT,
    'names': street_names,
    'values': [street_indexes[name] for name in nearest_names],
    'bearings': nearest_bearings,
}

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
(OUTPUT_DIR / 'sf-elevation-grid.json').write_text(json.dumps(elevation_output, separators=(',', ':')) + '\n')
(OUTPUT_DIR / 'sf-street-grid.json').write_text(json.dumps(street_output, separators=(',', ':')) + '\n')
