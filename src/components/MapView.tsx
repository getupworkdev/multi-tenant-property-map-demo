'use client'

import { Map as MapLibreMap, NavigationControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeatureCollection } from '@/lib/map-data'

export type LegendRow = { state: string; label: string; color: string }

type Record_ = {
  property: { id: string; source_id: string; address: string; city: string | null; postcode: string | null; owner_name: string; state: string }
  activities: { kind: string; status: string; occurred_at: string }[]
  crm: { status: string; crm_contacts: { name: string; external_id: string } | null }[]
}

// Free OpenStreetMap-based vector tiles, no token. Mapbox is a drop-in swap of this style URL.
const STYLE = 'https://tiles.openfreemap.org/styles/positron'

export function MapView({ legend }: { legend: LegendRow[] }) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibreMap | null>(null)
  const [enabled, setEnabled] = useState<string[]>(legend.map((l) => l.state))
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<Record_ | null>(null)
  const [ready, setReady] = useState(false)

  const label = (state: string) => legend.find((l) => l.state === state)?.label ?? state

  // The open record is kept in the URL (?property=<id>) so it can be shared or reloaded.
  const select = useCallback(async (id: string) => {
    const response = await fetch(`/api/properties/${id}`)
    if (!response.ok) return
    setSelected(await response.json())
    window.history.replaceState(null, '', `?property=${id}`)
  }, [])

  useEffect(() => {
    if (!container.current) return
    // The bundler can't follow MapLibre's worker import, so the worker is copied to /public at build time.
    setWorkerUrl('/maplibre-gl-worker.mjs')
    const m = new MapLibreMap({ container: container.current, style: STYLE, center: [-79.4, 43.68], zoom: 11.3 })
    map.current = m
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    m.on('load', () => {
      m.addSource('properties', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterRadius: 40,
        clusterMaxZoom: 14,
      })
      m.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'properties',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#1f2937',
          'circle-opacity': 0.82,
          'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 30, 24],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })
      m.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'properties',
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Bold'] },
        paint: { 'text-color': '#ffffff' },
      })
      m.addLayer({
        id: 'pins',
        type: 'circle',
        source: 'properties',
        filter: ['!', ['has', 'point_count']],
        paint: {
          // Colours come from the property_state_legend table.
          'circle-color': ['match', ['get', 'state'], ...legend.flatMap((l) => [l.state, l.color]), '#888888'] as never,
          'circle-radius': 7,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })
      m.on('click', 'pins', (e) => {
        const id = e.features?.[0]?.properties?.id
        if (id) select(id)
      })
      m.on('click', 'clusters', async (e) => {
        const feature = e.features?.[0]
        if (!feature) return
        const zoom = await (m.getSource('properties') as GeoJSONSource).getClusterExpansionZoom(feature.properties.cluster_id)
        m.easeTo({ center: (feature.geometry as GeoJSON.Point).coordinates as [number, number], zoom })
      })
      for (const layer of ['pins', 'clusters']) {
        m.on('mouseenter', layer, () => (m.getCanvas().style.cursor = 'pointer'))
        m.on('mouseleave', layer, () => (m.getCanvas().style.cursor = ''))
      }
      setReady(true)
    })
    return () => m.remove()
  }, [legend, select])

  // Filtering happens in the database (map_features), not by hiding pins in the browser.
  useEffect(() => {
    if (!ready) return
    const params = enabled.length === legend.length ? '' : `?states=${enabled.join(',') || 'none'}`
    fetch(`/api/map${params}`)
      .then((r) => r.json())
      .then((data: FeatureCollection) => {
        const features = enabled.length ? data.features : []
        ;(map.current?.getSource('properties') as GeoJSONSource | undefined)?.setData({ ...data, features } as never)
        if (enabled.length === legend.length) {
          setCounts(data.features.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.properties.state]: (acc[f.properties.state] ?? 0) + 1 }), {}))
        }
      })
  }, [enabled, ready, legend.length])

  useEffect(() => {
    if (!ready) return
    const id = new URLSearchParams(window.location.search).get('property')
    if (!id) return
    fetch(`/api/map`)
      .then((r) => r.json())
      .then((data: FeatureCollection) => {
        const feature = data.features.find((f) => f.properties.id === id)
        if (!feature) return
        map.current?.jumpTo({ center: feature.geometry.coordinates, zoom: 15.5 })
        select(id)
      })
  }, [ready, select])

  return (
    <div className="map-layout">
      <aside className="panel">
        <h2>Property states</h2>
        <p className="muted small">Priority order. Untick to filter; the server returns only the states you keep.</p>
        <ul className="legend">
          {legend.map((l) => (
            <li key={l.state}>
              <label>
                <input
                  type="checkbox"
                  checked={enabled.includes(l.state)}
                  onChange={(e) => setEnabled((cur) => (e.target.checked ? [...cur, l.state] : cur.filter((s) => s !== l.state)))}
                />
                <span className="swatch" style={{ background: l.color }} />
                {l.label}
                <span className="muted small"> {counts[l.state] ?? 0}</span>
              </label>
            </li>
          ))}
        </ul>

        {selected ? (
          <section className="record">
            <h3>{selected.property.address}</h3>
            <p className="badge" style={{ background: legend.find((l) => l.state === selected.property.state)?.color }}>
              {label(selected.property.state)}
            </p>
            <dl>
              <dt>Owner</dt>
              <dd>{selected.property.owner_name}</dd>
              <dt>Feed ID</dt>
              <dd>{selected.property.source_id}</dd>
              <dt>City</dt>
              <dd>
                {selected.property.city} {selected.property.postcode}
              </dd>
              <dt>Activity</dt>
              <dd>
                {selected.activities.length
                  ? selected.activities.map((a, i) => (
                      <div key={i}>
                        {a.kind.replace('_', ' ')} <span className="muted">({a.status})</span>
                      </div>
                    ))
                  : 'None'}
              </dd>
              <dt>CRM link</dt>
              <dd>
                {selected.crm.length
                  ? selected.crm.map((c, i) => (
                      <div key={i}>
                        {c.crm_contacts?.name} <span className="muted">({c.status.replace('_', ' ')})</span>
                      </div>
                    ))
                  : 'Not linked'}
              </dd>
            </dl>
          </section>
        ) : (
          <p className="muted small">Click a pin to open the property record. Click a cluster to zoom in.</p>
        )}
      </aside>
      <div ref={container} className="map" />
    </div>
  )
}
