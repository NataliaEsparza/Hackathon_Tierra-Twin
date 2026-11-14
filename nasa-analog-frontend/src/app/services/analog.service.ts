import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  institution: string;
}

export interface GeocodeCandidate {
  name: string;
  subtitle: string;
  fullName: string;
  lat: number;
  lon: number;
  type: string;
}

export interface GeocodeResponse {
  query: string;
  results: GeocodeCandidate[];
}

export interface EnvironmentalProfile {
  thermal: number;
  radiation: number;
  aridity: number;
  topography: number;
  geology: number;
  subsurface: number;
}

export interface SpaceTarget {
  id: string;
  name: string;
  celestialBody: string;
  coordinates: string;
  missionObjective: string;
  requiredGeology: string;
  requiresCaves: boolean;
  rawSpecs: {
    tempRange: string;
    solarIrradiance: string;
    atmosphere: string;
    terrain: string;
  };
  profile: EnvironmentalProfile;
}

export interface AnalogyCritiqueItem {
  dimension: string;
  matchPct: number;
  detail: string;
}

export interface ScientificCritique {
  strongAnalogies: AnalogyCritiqueItem[];
  analogyGaps: AnalogyCritiqueItem[];
  planetaryLimitations: string[];
  validationProtocols?: string[];
}

export interface EarthMatchResult {
  id: string;
  userId?: string;
  name: string;
  country: string;
  category: string;
  isCustom: boolean;
  isWaterBody?: boolean;
  elevation?: number | null;
  slopeDegrees?: number;
  savedAt?: string;
  matchedTargetName?: string;
  authorName?: string;
  authorInstitution?: string;
  lat: number;
  lon: number;
  geologyType: string;
  hasCaves: boolean;
  highlights: string;
  logisticNotes: string;
  climateData: {
    tMin: number;
    tMax: number;
    solar: number;
    precip: number;
    source: string;
  };
  scores: {
    planetarySimilarity: number;
    logisticViability: number;
    missionReadinessScore: number;
  };
  critique: ScientificCritique;
  radarComparison: {
    labels: string[];
    targetValues: number[];
    earthValues: number[];
  };
}

export interface MatchResponse {
  target: SpaceTarget;
  totalAnalyzed: number;
  results: EarthMatchResult[];
}

@Injectable({
  providedIn: 'root'
})
export class AnalogService {
  private readonly apiUrl = 'http://localhost:3000/api';

  constructor(private http: HttpClient) { }

  login(email: string, password: string): Observable<UserProfile> {
    return this.http.post<UserProfile>(`${this.apiUrl}/auth/login`, { email, password });
  }

  register(name: string, email: string, password: string, institution: string): Observable<UserProfile> {
    return this.http.post<UserProfile>(`${this.apiUrl}/auth/register`, {
      name,
      email,
      password,
      institution
    });
  }

  loginDemo(): Observable<UserProfile> {
    return this.http.post<UserProfile>(`${this.apiUrl}/auth/demo`, {});
  }

  searchPlace(query: string): Observable<GeocodeResponse> {
    return this.http.get<GeocodeResponse>(`${this.apiUrl}/geocode`, {
      params: { q: query }
    });
  }

  getTargets(): Observable<SpaceTarget[]> {
    return this.http.get<SpaceTarget[]>(`${this.apiUrl}/targets`);
  }

  findMatches(targetId: string, weights: EnvironmentalProfile): Observable<MatchResponse> {
    return this.http.post<MatchResponse>(`${this.apiUrl}/match`, {
      targetId,
      weights
    });
  }

  prospectCoordinate(
    lat: number,
    lon: number,
    targetId: string,
    weights: EnvironmentalProfile,
    geologyType: string,
    hasCaves: boolean,
    preferredName: string = ''
  ): Observable<EarthMatchResult> {
    return this.http.post<EarthMatchResult>(`${this.apiUrl}/prospect`, {
      lat,
      lon,
      targetId,
      weights,
      geologyType,
      hasCaves,
      preferredName
    });
  }

  getDiscoveries(userId?: string): Observable<EarthMatchResult[]> {
    const params: Record<string, string> = {};
    if (userId) {
      params['userId'] = userId;
    }
    return this.http.get<EarthMatchResult[]>(`${this.apiUrl}/discoveries`, { params });
  }

  saveDiscovery(
    site: EarthMatchResult,
    targetName: string,
    customName: string,
    notes: string,
    user: UserProfile | null
  ): Observable<EarthMatchResult> {
    return this.http.post<EarthMatchResult>(`${this.apiUrl}/discoveries`, {
      site,
      targetName,
      customName,
      notes,
      user
    });
  }

  deleteDiscovery(id: string, userId?: string): Observable<{ deleted: boolean }> {
    const params: Record<string, string> = userId ? { userId } : {};
    return this.http.delete<{ deleted: boolean }>(`${this.apiUrl}/discoveries/${id}`, { params });
  }
}