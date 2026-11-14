import {
  Component,
  OnInit,
  OnDestroy,
  HostListener,
  ViewChild,
  ElementRef,
  ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as L from 'leaflet';
import { Chart, registerables } from 'chart.js';
import {
  AnalogService,
  SpaceTarget,
  EarthMatchResult,
  EnvironmentalProfile,
  UserProfile,
  GeocodeCandidate
} from '../services/analog.service';

Chart.register(...registerables);

export type TabId = 'explorer' | 'analysis' | 'ranking' | 'database';

@Component({
  selector: 'app-dashboard',
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class Dashboard implements OnInit, OnDestroy {
  @ViewChild('mapContainer') mapContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('planetaryMapContainer') planetaryMapContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('earthCompareMapContainer') earthCompareMapContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('radarCanvas') radarCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('searchBoxContainer') searchBoxContainer?: ElementRef<HTMLElement>;

  activeTab: TabId = 'explorer';

  // Control de acceso previo a la plataforma
  currentUser: UserProfile | null = null;
  authMode: 'login' | 'register' = 'login';
  authName: string = '';
  authEmail: string = '';
  authPassword: string = '';
  authInstitution: string = '';
  authError: string = '';
  isAuthenticating: boolean = false;

  // Buscador mundial de ubicaciones con lista desplegable
  searchQuery: string = '';
  searchSuggestions: GeocodeCandidate[] = [];
  searchDropdownOpen: boolean = false;
  searchNoResults: boolean = false;
  isSearchingPlace: boolean = false;
  private searchTimer: any = null;

  targets: SpaceTarget[] = [];
  selectedTargetId: string = 'moon-marius-hills';
  activeTarget: SpaceTarget | null = null;

  results: EarthMatchResult[] = [];
  selectedSite: EarthMatchResult | null = null;
  customPinSite: EarthMatchResult | null = null;
  savedDiscoveries: EarthMatchResult[] = [];

  // Campos editables para guardar en la base de datos personal
  customSiteName: string = '';
  customSiteNotes: string = '';
  saveStatusMessage: string = '';
  isSavingDB: boolean = false;

  activeFilter: 'all' | 'understudied' | 'benchmark' | 'caves' = 'all';
  prospectMode: boolean = true;
  prospectGeology: string = 'basaltic-volcanic';
  prospectHasCaves: boolean = false;
  showNasaGibsLayer: boolean = false;
  showCatalogMarkers: boolean = true;

  isLoading: boolean = false;
  isProspecting: boolean = false;
  errorMessage: string = '';

  weights: EnvironmentalProfile = {
    thermal: 80,
    radiation: 85,
    aridity: 90,
    topography: 70,
    geology: 95,
    subsurface: 100
  };

  private map: L.Map | null = null;
  private mapResizeObserver: ResizeObserver | null = null;
  private markersLayer: L.LayerGroup = L.layerGroup();
  private nasaGibsLayer: L.TileLayer | null = null;

  private planetaryMap: L.Map | null = null;
  private earthCompareMap: L.Map | null = null;

  private radarChart: Chart | null = null;

  constructor(
    private analogService: AnalogService,
    private cdr: ChangeDetectorRef
  ) { }

  get filteredResults(): EarthMatchResult[] {
    if (this.activeFilter === 'understudied') {
      return this.results.filter((s) => s.category === 'understudied');
    }
    if (this.activeFilter === 'benchmark') {
      return this.results.filter((s) => s.category === 'benchmark');
    }
    if (this.activeFilter === 'caves') {
      return this.results.filter((s) => s.hasCaves);
    }
    return this.results;
  }

  getGeologyLabel(geologyType: string): string {
    const labels: Record<string, string> = {
      'basaltic-volcanic': 'Basalto volcánico (Mares lunares / Volcanes de Marte)',
      'anorthosite-regolith': 'Anortosita cristalina (Tierras altas y Polo Sur Lunar)',
      'sedimentary-evaporite': 'Sedimentos, salinas o arcillas (Antiguos lagos marcianos)',
      'permafrost-regolith': 'Permafrost o hielo (Polos y glaciares subsuperficiales)'
    };
    return labels[geologyType] || geologyType;
  }

  ngOnInit(): void {
    const storedUser = localStorage.getItem('terratwin_user');
    if (storedUser) {
      try {
        this.currentUser = JSON.parse(storedUser);
        if (this.currentUser) {
          this.enterPlatformWorkspace();
        }
      } catch {
        this.currentUser = null;
      }
    }
  }

  // ACCESO A LA PLATAFORMA
  switchAuthMode(mode: 'login' | 'register'): void {
    this.authMode = mode;
    this.authError = '';
    this.cdr.detectChanges();
  }

  submitAuth(): void {
    this.authError = '';
    this.isAuthenticating = true;
    this.cdr.detectChanges();

    if (this.authMode === 'login') {
      this.analogService.login(this.authEmail, this.authPassword).subscribe({
        next: (user) => {
          this.isAuthenticating = false;
          this.completeSignIn(user);
        },
        error: (err) => {
          this.isAuthenticating = false;
          this.authError =
            err.error?.error || 'No se pudo iniciar sesión. Verifica que el servidor esté encendido.';
          this.cdr.detectChanges();
        }
      });
    } else {
      this.analogService
        .register(this.authName, this.authEmail, this.authPassword, this.authInstitution)
        .subscribe({
          next: (user) => {
            this.isAuthenticating = false;
            this.completeSignIn(user);
          },
          error: (err) => {
            this.isAuthenticating = false;
            this.authError =
              err.error?.error || 'No se pudo crear la cuenta. Verifica que el servidor esté encendido.';
            this.cdr.detectChanges();
          }
        });
    }
  }

  enterDemoMode(): void {
    this.authError = '';
    this.isAuthenticating = true;
    this.cdr.detectChanges();

    this.analogService.loginDemo().subscribe({
      next: (user) => {
        this.isAuthenticating = false;
        this.completeSignIn(user);
      },
      error: () => {
        this.isAuthenticating = false;
        this.authError = 'No se detecta el servidor en http://localhost:3000. Enciéndelo primero.';
        this.cdr.detectChanges();
      }
    });
  }

  private completeSignIn(user: UserProfile): void {
    this.currentUser = user;
    localStorage.setItem('terratwin_user', JSON.stringify(user));
    this.activeTab = 'explorer';
    this.cdr.detectChanges();
    this.enterPlatformWorkspace();
  }

  private enterPlatformWorkspace(): void {
    this.loadInitialData();
    this.loadSavedDiscoveries();
    setTimeout(() => {
      this.initMap();
    }, 120);
  }

  logout(): void {
    this.currentUser = null;
    localStorage.removeItem('terratwin_user');
    this.cleanupResources();
    this.cdr.detectChanges();
  }

  // NAVEGACIÓN Y MAPAS
  setTab(tab: TabId): void {
    if (this.activeTab === 'analysis' && tab !== 'analysis') {
      this.destroyOrbitalMaps();
    }

    this.activeTab = tab;
    this.cdr.detectChanges();

    if (tab === 'explorer') {
      setTimeout(() => {
        if (!this.map) {
          this.initMap();
        } else {
          this.map.invalidateSize();
        }
      }, 80);
    } else if (tab === 'analysis') {
      setTimeout(() => {
        this.initOrbitalMaps();
        this.renderRadarChart();
      }, 90);
    } else if (tab === 'database') {
      this.loadSavedDiscoveries();
    }
  }

  private initMap(): void {
    if (!this.mapContainer || this.map) return;

    const el = this.mapContainer.nativeElement;

    this.map = L.map(el, {
      center: [24.0277, -104.6532],
      zoom: 4,
      zoomControl: true
    });

    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'NASA / Esri World Imagery',
        maxZoom: 18
      }
    ).addTo(this.map);

    const gibsDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    this.nasaGibsLayer = L.tileLayer(
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${gibsDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
      {
        attribution: 'NASA EOSDIS GIBS',
        maxNativeZoom: 9,
        maxZoom: 18,
        opacity: 0.78
      }
    );

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
      {
        subdomains: 'abcd',
        maxZoom: 18
      }
    ).addTo(this.map);

    this.markersLayer.addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.searchSuggestions = [];
      this.searchDropdownOpen = false;
      if (this.prospectMode) {
        this.analyzeCustomCoordinate(e.latlng.lat, e.latlng.lng, '', 10, true);
      }
    });

    setTimeout(() => {
      this.map?.invalidateSize();
    }, 250);

    if (this.mapResizeObserver) {
      this.mapResizeObserver.disconnect();
    }
    this.mapResizeObserver = new ResizeObserver(() => {
      this.map?.invalidateSize();
    });
    this.mapResizeObserver.observe(el);

    if (this.results.length > 0 || this.savedDiscoveries.length > 0) {
      this.updateMapMarkers();
    }
  }

  // VISOR ORBITAL DE LA LUNA Y MARTE
  private parseTargetCoordinates(coordStr: string): { lat: number; lon: number } {
    const match = coordStr.match(/([\d.]+)\s*°?\s*([NS])\s*,\s*([\d.]+)\s*°?\s*([EW])/i);
    if (!match) {
      return { lat: 0, lon: 0 };
    }
    let lat = parseFloat(match[1]);
    if (match[2].toUpperCase() === 'S') lat = -lat;

    let lon = parseFloat(match[3]);
    if (match[4].toUpperCase() === 'W') lon = -lon;
    if (lon > 180) lon = lon - 360;

    const safeLat = Math.max(-89.9, Math.min(89.9, lat));
    return { lat: safeLat, lon };
  }

  private initOrbitalMaps(): void {
    this.destroyOrbitalMaps();

    if (!this.activeTarget || !this.selectedSite) return;

    if (this.planetaryMapContainer) {
      const planetEl = this.planetaryMapContainer.nativeElement;
      const coords = this.parseTargetCoordinates(this.activeTarget.coordinates);
      const isMars = this.activeTarget.celestialBody === 'Marte';

      const trekUrl = isMars
        ? 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg'
        : 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg';

      this.planetaryMap = L.map(planetEl, {
        crs: L.CRS.EPSG4326,
        center: [coords.lat, coords.lon],
        zoom: 4,
        minZoom: 1,
        maxZoom: 7,
        maxBounds: [
          [-90, -180],
          [90, 180]
        ],
        zoomControl: true
      });

      L.tileLayer(trekUrl, {
        attribution: isMars ? 'NASA Mars Trek · MGS MOLA' : 'NASA Moon Trek · LRO WAC',
        maxNativeZoom: isMars ? 5 : 7,
        noWrap: true,
        bounds: [
          [-90, -180],
          [90, 180]
        ]
      }).addTo(this.planetaryMap);

      const targetIcon = L.divIcon({
        className: 'nasa-pin-wrapper',
        html: `<div class="orbital-reticle"></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });

      L.marker([coords.lat, coords.lon], { icon: targetIcon })
        .bindTooltip(
          `<strong>${this.activeTarget.name}</strong><br/>${this.activeTarget.coordinates}`,
          { direction: 'top' }
        )
        .addTo(this.planetaryMap);

      setTimeout(() => {
        this.planetaryMap?.invalidateSize();
      }, 150);
    }

    if (this.earthCompareMapContainer) {
      const earthEl = this.earthCompareMapContainer.nativeElement;
      const { lat, lon, name, country } = this.selectedSite;

      this.earthCompareMap = L.map(earthEl, {
        center: [lat, lon],
        zoom: 12,
        zoomControl: true
      });

      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          attribution: 'NASA / Esri World Imagery',
          maxZoom: 18
        }
      ).addTo(this.earthCompareMap);

      const earthIcon = L.divIcon({
        className: 'nasa-pin-wrapper',
        html: `<div class="nasa-pin selected"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });

      L.marker([lat, lon], { icon: earthIcon })
        .bindTooltip(`<strong>${name}</strong><br/>${country}`, { direction: 'top' })
        .addTo(this.earthCompareMap);

      setTimeout(() => {
        this.earthCompareMap?.invalidateSize();
      }, 150);
    }
  }

  recenterPlanetaryOrbit(): void {
    if (!this.planetaryMap || !this.activeTarget) return;
    const coords = this.parseTargetCoordinates(this.activeTarget.coordinates);
    this.planetaryMap.flyTo([coords.lat, coords.lon], 4, { duration: 1 });
  }

  recenterEarthOrbit(): void {
    if (!this.earthCompareMap || !this.selectedSite) return;
    this.earthCompareMap.flyTo([this.selectedSite.lat, this.selectedSite.lon], 12, { duration: 1 });
  }

  private destroyOrbitalMaps(): void {
    if (this.planetaryMap) {
      this.planetaryMap.remove();
      this.planetaryMap = null;
    }
    if (this.earthCompareMap) {
      this.earthCompareMap.remove();
      this.earthCompareMap = null;
    }
  }

  toggleNasaGibs(): void {
    if (!this.map || !this.nasaGibsLayer) return;
    this.showNasaGibsLayer = !this.showNasaGibsLayer;
    if (this.showNasaGibsLayer) {
      this.nasaGibsLayer.addTo(this.map);
    } else {
      this.map.removeLayer(this.nasaGibsLayer);
    }
  }

  toggleProspectMode(): void {
    this.prospectMode = !this.prospectMode;
  }

  toggleCatalogMarkers(): void {
    this.showCatalogMarkers = !this.showCatalogMarkers;
    this.updateMapMarkers();
  }

  // BUSCADOR DE UBICACIONES
  onSearchInputChange(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }

    const q = this.searchQuery.trim();
    this.searchNoResults = false;

    if (q.length < 2) {
      this.searchSuggestions = [];
      this.searchDropdownOpen = false;
      return;
    }

    this.searchTimer = setTimeout(() => {
      this.fetchLocationOptions(q);
    }, 300);
  }

  searchLocationByText(): void {
    const q = this.searchQuery.trim();
    if (q.length < 2) return;

    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }

    this.fetchLocationOptions(q);
  }

  private fetchLocationOptions(q: string): void {
    this.isSearchingPlace = true;
    this.searchDropdownOpen = true;
    this.searchNoResults = false;
    this.errorMessage = '';
    this.cdr.detectChanges();

    this.analogService.searchPlace(q).subscribe({
      next: (res) => {
        this.isSearchingPlace = false;
        this.searchSuggestions = res.results || [];
        this.searchNoResults = this.searchSuggestions.length === 0;
        this.searchDropdownOpen = true;
        this.cdr.detectChanges();
      },
      error: () => {
        this.isSearchingPlace = false;
        this.searchSuggestions = [];
        this.searchNoResults = true;
        this.searchDropdownOpen = true;
        this.cdr.detectChanges();
      }
    });
  }

  closeSearchDropdown(): void {
    this.searchDropdownOpen = false;
  }

  selectSearchSuggestion(item: GeocodeCandidate): void {
    const selectedLabel = item.fullName || item.name;
    this.searchQuery = selectedLabel;
    this.searchSuggestions = [];
    this.searchDropdownOpen = false;
    this.searchNoResults = false;
    this.prospectMode = true;
    this.analyzeCustomCoordinate(item.lat, item.lon, selectedLabel, 12, true);
  }

  onCustomGeologyOrCavesChange(): void {
    if (!this.selectedSite || !this.selectedSite.isCustom) return;
    const currentZoom = this.map ? this.map.getZoom() : 11;
    const keepName = this.customSiteName.trim() || this.selectedSite.name;
    this.analyzeCustomCoordinate(
      this.selectedSite.lat,
      this.selectedSite.lon,
      keepName,
      currentZoom,
      false
    );
  }

  analyzeCustomCoordinate(
    lat: number,
    lon: number,
    preferredName: string = '',
    zoomLevel: number = 11,
    flyToLocation: boolean = true
  ): void {
    this.isProspecting = true;
    this.saveStatusMessage = '';
    this.cdr.detectChanges();

    this.analogService
      .prospectCoordinate(
        lat,
        lon,
        this.selectedTargetId,
        this.weights,
        this.prospectGeology,
        this.prospectHasCaves,
        preferredName
      )
      .subscribe({
        next: (discoveredSite) => {
          const previousNotes =
            this.selectedSite &&
            this.selectedSite.isCustom &&
            Math.abs(this.selectedSite.lat - lat) < 0.0001 &&
            Math.abs(this.selectedSite.lon - lon) < 0.0001 &&
            this.customSiteNotes.trim() &&
            this.customSiteNotes !== this.selectedSite.highlights
              ? this.customSiteNotes
              : discoveredSite.highlights;

          this.customPinSite = discoveredSite;
          this.isProspecting = false;
          this.selectSite(discoveredSite, flyToLocation, false, zoomLevel);
          this.customSiteNotes = previousNotes;
          this.cdr.detectChanges();
        },
        error: () => {
          this.isProspecting = false;
          this.errorMessage = 'No se pudo consultar esa coordenada. Verifica que el servidor esté encendido.';
          this.cdr.detectChanges();
        }
      });
  }

  saveCurrentToDatabase(): void {
    if (!this.selectedSite) return;

    this.isSavingDB = true;
    this.saveStatusMessage = '';
    this.cdr.detectChanges();

    this.analogService
      .saveDiscovery(
        this.selectedSite,
        this.activeTarget?.name || 'Misión espacial',
        this.customSiteName,
        this.customSiteNotes,
        this.currentUser
      )
      .subscribe({
        next: (savedItem) => {
          this.isSavingDB = false;
          this.saveStatusMessage = `Guardado en tu base de datos (${savedItem.name})`;
          this.loadSavedDiscoveries();
          this.cdr.detectChanges();
        },
        error: () => {
          this.isSavingDB = false;
          this.saveStatusMessage = 'No se pudo guardar. Verifica que el servidor esté encendido.';
          this.cdr.detectChanges();
        }
      });
  }

  loadSavedDiscoveries(): void {
    this.analogService.getDiscoveries(this.currentUser?.id).subscribe({
      next: (list) => {
        this.savedDiscoveries = list;
        this.updateMapMarkers();
        this.cdr.detectChanges();
      }
    });
  }

  deleteFromDatabase(id: string): void {
    this.analogService.deleteDiscovery(id, this.currentUser?.id).subscribe({
      next: () => {
        this.loadSavedDiscoveries();
      }
    });
  }

  loadInitialData(): void {
    this.isLoading = true;
    this.analogService.getTargets().subscribe({
      next: (data) => {
        this.targets = data;
        if (data.length > 0) {
          this.selectedTargetId = data[0].id;
          this.runSimulation();
        }
        this.cdr.detectChanges();
      },
      error: () => {
        this.errorMessage =
          'No se detecta el servidor en http://localhost:3000. Enciéndelo con node server.js.';
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  onTargetChange(): void {
    const target = this.targets.find((t) => t.id === this.selectedTargetId);
    if (target) {
      this.weights.subsurface = target.requiresCaves ? 100 : 25;
    }
    this.runSimulation();
  }

  runSimulation(): void {
    this.isLoading = true;
    this.errorMessage = '';

    this.analogService.findMatches(this.selectedTargetId, this.weights).subscribe({
      next: (response) => {
        this.activeTarget = response.target;
        this.results = response.results;
        this.isLoading = false;

        if (this.selectedSite?.isCustom) {
          const currentZoom = this.map ? this.map.getZoom() : 11;
          this.analyzeCustomCoordinate(
            this.selectedSite.lat,
            this.selectedSite.lon,
            this.customSiteName || this.selectedSite.name,
            currentZoom,
            false
          );
          return;
        }

        if (this.results.length > 0) {
          const stillExists = this.results.find((r) => r.id === this.selectedSite?.id);
          this.selectSite(stillExists || this.results[0], false);
        }

        this.updateMapMarkers();

        if (this.activeTab === 'analysis') {
          setTimeout(() => {
            this.initOrbitalMaps();
            this.renderRadarChart();
          }, 80);
        }

        this.cdr.detectChanges();
      },
      error: () => {
        this.errorMessage = 'Error al calcular similitudes.';
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  selectSite(
    site: EarthMatchResult,
    flyToLocation: boolean = true,
    switchToExplorer: boolean = false,
    zoomLevel: number = 10
  ): void {
    this.selectedSite = site;
    this.customSiteName = site.name;
    this.customSiteNotes = site.highlights;
    this.saveStatusMessage = '';

    if (site.geologyType) {
      this.prospectGeology = site.geologyType;
    }
    this.prospectHasCaves = Boolean(site.hasCaves);

    if (switchToExplorer) {
      if (this.activeTab === 'analysis') {
        this.destroyOrbitalMaps();
      }
      this.activeTab = 'explorer';
    }

    this.updateMapMarkers();
    this.cdr.detectChanges();

    if (flyToLocation && this.map && this.activeTab === 'explorer') {
      setTimeout(() => {
        this.map?.invalidateSize();
        this.map?.flyTo([site.lat, site.lon], zoomLevel, { duration: 1.1 });
      }, 60);
    }

    if (this.activeTab === 'analysis') {
      setTimeout(() => {
        this.initOrbitalMaps();
        this.renderRadarChart();
      }, 80);
    }
  }

  exportMissionReport(): void {
    window.print();
  }

  exportMarkdownReport(): void {
    if (!this.selectedSite || !this.activeTarget) return;
    const s = this.selectedSite;
    const t = this.activeTarget;
    const protocols = s.critique.validationProtocols || [];

    const md = [
      `# Ficha Científica de Análogo Planetario — TERRA-TWIN`,
      `**Fecha:** ${new Date().toLocaleDateString('es-MX')} | **Investigador:** ${this.currentUser?.name || 'Invitado'}`,
      `\n## 1. Comparativa General`,
      `- **Sitio Terrestre:** ${s.name} (${s.country}) [${s.lat}°, ${s.lon}°]`,
      `- **Geología / Subsuelo:** ${this.getGeologyLabel(s.geologyType)} · ${s.hasCaves ? 'Con cuevas / tubos volcánicos' : 'Superficie abierta'}`,
      `- **Destino Espacial:** ${t.name} (${t.celestialBody} — ${t.coordinates})`,
      `- **Similitud Planetaria:** ${s.scores.planetarySimilarity}% | **Viabilidad Logística:** ${s.scores.logisticViability}% | **Puntaje Global:** ${s.scores.missionReadinessScore}%`,
      `\n## 2. Telemetría Satelital (${s.climateData.source})`,
      `- Temperatura: ${s.climateData.tMin} °C a ${s.climateData.tMax} °C`,
      `- Irradiancia Solar: ${s.climateData.solar} kWh/m²/día | Precipitación: ${s.climateData.precip} mm/día`,
      `\n## 3. Fortalezas de la Analogía`,
      ...s.critique.strongAnalogies.map((a) => `- **${a.dimension} (${a.matchPct}%):** ${a.detail}`),
      `\n## 4. Brechas y Limitaciones Físicas No Reproducibles`,
      ...s.critique.analogyGaps.map((g) => `- **${g.dimension} (${g.matchPct}%):** ${g.detail}`),
      ...s.critique.planetaryLimitations.map((l) => `- ${l}`),
      ...(protocols.length > 0
        ? [`\n## 5. Protocolos de Validación Recomendados`, ...protocols.map((p) => `- ${p}`)]
        : [])
    ].join('\n');

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TERRA-TWIN_${s.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private updateMapMarkers(): void {
    if (!this.map) return;
    this.markersLayer.clearLayers();

    if (this.showCatalogMarkers) {
      this.results.forEach((site, index) => {
        const isSelected = this.selectedSite?.id === site.id;
        const isTop3 = index < 3;
        const pinClass = `nasa-pin ${isTop3 ? 'top-match' : ''} ${isSelected ? 'selected' : ''}`;

        const icon = L.divIcon({
          className: 'nasa-pin-wrapper',
          html: `<div class="${pinClass}"></div>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        });

        const marker = L.marker([site.lat, site.lon], { icon });
        marker.bindTooltip(
          `<strong>${site.name}</strong><br/>Parecido: ${site.scores.planetarySimilarity}%`,
          { direction: 'top' }
        );
        marker.on('click', () => {
          this.selectSite(site, true, false, 10);
        });
        marker.addTo(this.markersLayer);
      });
    }

    const catalogCoords = this.showCatalogMarkers
      ? new Set(this.results.map((r) => `${r.lat.toFixed(3)},${r.lon.toFixed(3)}`))
      : new Set<string>();

    const extraPins = [...this.savedDiscoveries].filter(
      (d) => !catalogCoords.has(`${d.lat.toFixed(3)},${d.lon.toFixed(3)}`)
    );
    if (this.customPinSite && !extraPins.some((p) => p.id === this.customPinSite?.id)) {
      extraPins.push(this.customPinSite);
    }

    extraPins.forEach((site) => {
      const isSelected = this.selectedSite?.id === site.id;
      const icon = L.divIcon({
        className: 'nasa-pin-wrapper',
        html: `<div class="nasa-pin custom-pin ${isSelected ? 'selected' : ''}"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      const marker = L.marker([site.lat, site.lon], { icon });
      marker.bindTooltip(`<strong>${site.name}</strong>`, { direction: 'top' });
      marker.on('click', () => {
        this.selectSite(site, true, false, 12);
      });
      marker.addTo(this.markersLayer);
    });
  }

  private renderRadarChart(): void {
    if (!this.radarCanvas || !this.selectedSite || !this.activeTarget) return;
    const ctx = this.radarCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    if (this.radarChart) {
      this.radarChart.destroy();
    }

    const { labels, targetValues, earthValues } = this.selectedSite.radarComparison;

    this.radarChart = new Chart(ctx, {
      type: 'radar',
      data: {
        labels,
        datasets: [
          {
            label: `${this.activeTarget.name} (${this.activeTarget.celestialBody})`,
            data: targetValues,
            backgroundColor: 'rgba(225, 29, 72, 0.22)',
            borderColor: '#ff2a4b',
            pointBackgroundColor: '#ff2a4b',
            borderWidth: 2.5
          },
          {
            label: `${this.selectedSite.name} (Tierra)`,
            data: earthValues,
            backgroundColor: 'rgba(56, 189, 248, 0.22)',
            borderColor: '#38bdf8',
            pointBackgroundColor: '#38bdf8',
            borderWidth: 2.5
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: { display: false, stepSize: 25 },
            grid: { color: 'rgba(255, 255, 255, 0.12)' },
            angleLines: { color: 'rgba(255, 255, 255, 0.12)' },
            pointLabels: {
              color: '#e4e4e7',
              font: { size: 12, weight: 'bold', family: 'DM Sans' }
            }
          }
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#f4f4f6',
              padding: 16,
              font: { size: 12, family: 'DM Sans' }
            }
          }
        }
      }
    });
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (
      this.searchDropdownOpen &&
      this.searchBoxContainer &&
      !this.searchBoxContainer.nativeElement.contains(event.target as Node)
    ) {
      this.searchDropdownOpen = false;
    }
  }

  ngOnDestroy(): void {
    this.cleanupResources();
  }

  private cleanupResources(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.mapResizeObserver) {
      this.mapResizeObserver.disconnect();
      this.mapResizeObserver = null;
    }
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.destroyOrbitalMaps();
    if (this.radarChart) {
      this.radarChart.destroy();
      this.radarChart = null;
    }
  }
}