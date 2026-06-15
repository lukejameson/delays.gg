<script lang="ts">
  import type { PageData } from './$types';
  import { browser } from '$app/environment';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import { airportName, getAirportCoords, getAirportsForNearestSearch } from '$lib/airports';
  import Icon from '$lib/components/Icon.svelte';
  import type { IconName } from '$lib/components/Icon.svelte';
  import { getWeatherIconName, isDaytime } from '$lib/daylight';
  import { formatGuernseyTime, formatGuernseyDateTime, formatGuernseyShortDate } from '$lib/time';
  import { shortenStatus, statusHasDetail, extractDelayReason, isFlightCompleted } from '$lib/status';
  import { getStatusTone, STATUS_TEXT_CLASSES, STATUS_DOT_CLASSES, STATUS_PILL_CLASSES } from '$lib/statusConfig';
  import DelayCounter from '$lib/components/DelayCounter.svelte';
  import FlightHeader from './components/FlightHeader.svelte';
  import DelayAnalysis from './components/DelayAnalysis.svelte';
  import FlightTimeline from './components/FlightTimeline.svelte';
  import FlightMap from './components/FlightMap.svelte';
  import RotationHistory from './components/RotationHistory.svelte';
  import WeatherDisplay from './components/WeatherDisplay.svelte';

  let { data }: { data: PageData } = $props();
  const returnTab = $derived($page.url.searchParams.get('tab') ?? '');

  const {
    flight,
    statusHistory,
    weatherMap,
    daylightMap,
    position,
    rotationFlights,
    times
  } = $derived(data);

  const depWeather = $derived(weatherMap?.[flight.departureAirport] ?? null);
  const arrWeather = $derived(weatherMap?.[flight.arrivalAirport] ?? null);

  // Determine if it's currently daytime at departure and arrival airports
  const depIsDay = $derived.by(() => {
    const daylight = daylightMap?.[flight.departureAirport]?.[0];
    if (!daylight) return true;
    return isDaytime(new Date(daylight.sunrise), new Date(daylight.sunset), new Date());
  });
  const arrIsDay = $derived.by(() => {
    const daylight = daylightMap?.[flight.arrivalAirport]?.[0];
    if (!daylight) return true;
    return isDaytime(new Date(daylight.sunrise), new Date(daylight.sunset), new Date());
  });

  const isDeparture = $derived(flight.departureAirport === 'GCI');
  const isCompleted = $derived(isFlightCompleted(flight));
  const isPreDeparture = $derived(
    !flight.actualDeparture &&
    !['airborne', 'taxiing', 'landed', 'completed', 'cancelled', 'canceled']
      .some(s => flight.status?.toLowerCase().includes(s))
  );

  // Derived values for timeline
  const estimatedDeparture = $derived.by(() => {
    const entry = times?.find((t: { timeType: string }) => t.timeType === 'EstimatedBlockOff');
    return entry?.timeValue ?? null;
  });
  const estimatedArrival = $derived.by(() => {
    const entry = times?.find((t: { timeType: string }) => t.timeType === 'EstimatedBlockOn');
    return entry?.timeValue ?? null;
  });

  // Actual times: prefer flights table, fall back to flight_times (FR24 writes
  // ActualBlockOff/ActualBlockOn even when guernsey-scraper hasn't set the column)
  const actualDeparture = $derived.by(() => {
    if (flight.actualDeparture) return flight.actualDeparture;
    const entry = times?.find((t: { timeType: string }) => t.timeType === 'ActualBlockOff');
    return entry?.timeValue ?? null;
  });
  const actualArrival = $derived.by(() => {
    if (flight.actualArrival) return flight.actualArrival;
    const entry = times?.find((t: { timeType: string }) => t.timeType === 'ActualBlockOn');
    return entry?.timeValue ?? null;
  });

  // Destructure flight for template use
  const scheduledDeparture = $derived(flight.scheduledDeparture);

  // SEO
  const seoTitle = $derived(`${flight.flightNumber}: ${airportName(flight.departureAirport)} → ${airportName(flight.arrivalAirport)} | airways.gg`);
  const seoDate = $derived(
    flight.scheduledDeparture
      ? new Date(flight.scheduledDeparture).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' })
      : ''
  );
  const seoDescription = $derived(
    `${flight.flightNumber} from ${flight.departureAirport} to ${flight.arrivalAirport}${seoDate ? ` on ${seoDate}` : ''}. Track live flight status and delay predictions on airways.gg.`
  );
  const seoCanonical = $derived(`${data.siteUrl}/flights/${flight.id}`);

  // Auto-refresh
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    if (browser) {
      refreshInterval = setInterval(() => { invalidateAll(); }, 60_000);
    }
    return () => {
      if (refreshInterval) clearInterval(refreshInterval);
    };
  });

  // Recently viewed
  $effect(() => {
    if (browser) {
      const key = 'recentlyViewedFlights';
      let existing: unknown[];
      try {
        existing = JSON.parse(localStorage.getItem(key) || '[]');
        if (!Array.isArray(existing)) existing = [];
      } catch {
        existing = [];
      }
      const flightInfo = {
        id: flight.id,
        flightNumber: flight.flightNumber,
        departureAirport: flight.departureAirport,
        arrivalAirport: flight.arrivalAirport,
        scheduledDeparture: flight.scheduledDeparture,
        viewedAt: new Date().toISOString(),
      };
      const filtered = (existing as { id: number }[]).filter(f => f.id !== flight.id);
      const updated = [flightInfo, ...filtered].slice(0, 5);
      const serialized = JSON.stringify(updated);
      localStorage.setItem(key, serialized);
      document.cookie = `rv=${encodeURIComponent(serialized)}; max-age=${30 * 24 * 60 * 60}; path=/; SameSite=Lax; Secure`;
    }
  });

  // Share functionality
  let shareSuccess = $state(false);
  async function shareFlight() {
    const shareData = {
      title: `${flight.flightNumber} — airways.gg`,
      text: `Track ${flight.flightNumber} from ${airportName(flight.departureAirport)} to ${airportName(flight.arrivalAirport)}`,
      url: window.location.href,
    };

    if (navigator.share) {
      try { await navigator.share(shareData); } catch { /* User cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(window.location.href);
        shareSuccess = true;
        setTimeout(() => shareSuccess = false, 2000);
      } catch { /* Clipboard failed */ }
    }
  }

  // Rotation helpers
  function getMostRecentLandedRotationFlight() {
    if (!rotationFlights || rotationFlights.length === 0) return null;
    const currentFlightDep = new Date(flight.scheduledDeparture).getTime();

    const landedBefore = rotationFlights.filter(f => {
      const isLanded = isFlightCompleted(f);
      const depTime = new Date(f.scheduledDeparture).getTime();
      return isLanded && depTime < currentFlightDep;
    });

    if (landedBefore.length === 0) return null;

    return landedBefore.sort((a, b) => {
      const aTime = a.actualArrival ? new Date(a.actualArrival).getTime() : new Date(a.scheduledArrival).getTime();
      const bTime = b.actualArrival ? new Date(b.actualArrival).getTime() : new Date(b.scheduledArrival).getTime();
      return bTime - aTime;
    })[0];
  }

  function getInferredLocationFromRotation(): { airport: string; source: string } | null {
    if (isFlightCompleted(flight)) {
      return { airport: flight.arrivalAirport, source: 'rotation' };
    }

    const mostRecent = getMostRecentLandedRotationFlight();
    if (!mostRecent) return null;
    return { airport: mostRecent.arrivalAirport, source: 'rotation' };
  }

  const inferredLocation = $derived(getInferredLocationFromRotation());

  const rotationOverridesPosition = $derived.by(() => {
    if (!position) return false;
    if (!position.fr24Id?.startsWith('INFERRED_')) return false;

    const mostRecent = getMostRecentLandedRotationFlight();
    if (!mostRecent) return false;

    const rotationArrival = mostRecent.actualArrival
      ? new Date(mostRecent.actualArrival).getTime()
      : new Date(mostRecent.scheduledArrival).getTime();
    const inferredAt = new Date(position.positionTimestamp).getTime();
    const rotationAirport = mostRecent.arrivalAirport;
    const inferredAirport = position.destIata ?? null;

    return rotationArrival > inferredAt || rotationAirport !== inferredAirport;
  });

  // Format helpers
  function formatTime(date: string | Date | null | undefined): string {
    return formatGuernseyTime(date);
  }
  function formatDateTime(date: string | Date | null | undefined): string {
    return formatGuernseyDateTime(date);
  }
  function shortDate(date: string | Date | null | undefined): string {
    return formatGuernseyShortDate(date);
  }
  const getStatusColor = (status: string | null | undefined, canceled?: boolean | null) =>
    STATUS_TEXT_CLASSES[getStatusTone(status, canceled)];
  const getStatusDotColor = (status: string | null | undefined, canceled?: boolean | null) =>
    STATUS_DOT_CLASSES[getStatusTone(status, canceled)];


</script>

<svelte:head>
  <title>{seoTitle}</title>
  <meta name="description" content={seoDescription} />
  <link rel="canonical" href={seoCanonical} />

  <meta property="og:title" content={seoTitle} />
  <meta property="og:description" content={seoDescription} />
  <meta property="og:url" content={seoCanonical} />
  <meta property="og:type" content="article" />

  <meta name="twitter:title" content={seoTitle} />
  <meta name="twitter:description" content={seoDescription} />

  {@html `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Guernsey Airport Flights", "item": data.siteUrl },
      { "@type": "ListItem", "position": 2, "name": flight.flightNumber, "item": seoCanonical }
    ]
  })}</script>`}
</svelte:head>

<div class="container py-4 sm:py-6 max-w-3xl">
  <FlightHeader
    flightNumber={flight.flightNumber}
    airlineCode={flight.airlineCode}
    departureAirport={flight.departureAirport}
    arrivalAirport={flight.arrivalAirport}
    {isDeparture}
    {scheduledDeparture}
    {actualDeparture}
    {estimatedDeparture}
    {actualArrival}
    {estimatedArrival}
    delayMinutes={flight.delayMinutes}
    status={flight.status}
    canceled={flight.canceled}
    {isCompleted}
    flightDate={flight.flightDate}
    onShare={shareFlight}
    {shareSuccess}
    {returnTab}
  />

  <DelayAnalysis
    status={flight.status}
    canceled={flight.canceled}
    {isDeparture}
    {statusHistory}
    delayMinutes={flight.delayMinutes}
    {depWeather}
    {arrWeather}
    departureAirport={flight.departureAirport}
    arrivalAirport={flight.arrivalAirport}
  />

  <FlightTimeline
    {isDeparture}
    departureAirport={flight.departureAirport}
    arrivalAirport={flight.arrivalAirport}
    scheduledDeparture={flight.scheduledDeparture}
    scheduledArrival={flight.scheduledArrival}
    actualDeparture={flight.actualDeparture}
    actualArrival={flight.actualArrival}
    {estimatedDeparture}
    {estimatedArrival}
    delayMinutes={flight.delayMinutes}
    canceled={flight.canceled}
    {isCompleted}
  />

  <FlightMap
    {position}
    departureAirport={flight.departureAirport}
    arrivalAirport={flight.arrivalAirport}
    {rotationOverridesPosition}
    {inferredLocation}
    {isPreDeparture}
  />

  {#if flight.aircraftRegistration && rotationFlights && rotationFlights.length > 1}
    <RotationHistory
      {rotationFlights}
      aircraftRegistration={flight.aircraftRegistration}
      currentFlightId={flight.id}
    />
  {/if}

  <WeatherDisplay
    {depWeather}
    {arrWeather}
    departureAirport={flight.departureAirport}
    arrivalAirport={flight.arrivalAirport}
    isDayAtDep={depIsDay}
    isDayAtArr={arrIsDay}
  />

  <!-- Flight details -->
  <div class="grid gap-4 mb-6">
    <div class="rounded-lg border bg-card p-4">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Flight Details</h2>
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between">
          <dt class="text-muted-foreground">Route</dt>
          <dd class="font-medium">
            {airportName(flight.departureAirport)} <span class="text-muted-foreground font-normal">({flight.departureAirport})</span>
            →
            {airportName(flight.arrivalAirport)} <span class="text-muted-foreground font-normal">({flight.arrivalAirport})</span>
          </dd>
        </div>
        {#if flight.aircraftType}
          <div class="flex justify-between">
            <dt class="text-muted-foreground">Aircraft</dt>
            <dd class="font-medium">{flight.aircraftType}</dd>
          </div>
        {/if}
        {#if flight.aircraftRegistration}
          <div class="flex justify-between">
            <dt class="text-muted-foreground">Registration</dt>
            <dd class="font-medium font-mono">{flight.aircraftRegistration}</dd>
          </div>
        {/if}
        {#if estimatedDeparture}
          <div class="flex justify-between">
            <dt class="text-muted-foreground">Estimated departure</dt>
            <dd class="font-medium text-yellow-600">{formatTime(estimatedDeparture)}</dd>
          </div>
        {:else}
          <div class="flex justify-between">
            <dt class="text-muted-foreground">Scheduled departure</dt>
            <dd class="font-medium">{formatTime(flight.scheduledDeparture)}</dd>
          </div>
        {/if}
        {#if estimatedArrival}
          <div class="flex justify-between">
            <dt class="text-muted-foreground">Estimated arrival</dt>
            <dd class="font-medium text-yellow-600">{formatTime(estimatedArrival)}</dd>
          </div>
        {:else}
          <div class="flex justify-between">
            <dt class="text-muted-foreground">Scheduled arrival</dt>
            <dd class="font-medium">{formatTime(flight.scheduledArrival)}</dd>
          </div>
        {/if}
        {#if flight.actualDeparture}
          <div class="flex justify-between">
            <dt class="text-muted-foreground">Actual departure</dt>
            <dd class="font-medium">{formatTime(flight.actualDeparture)}</dd>
          </div>
        {/if}
        {#if flight.actualArrival}
          <div class="flex justify-between">
            <dt class="text-muted-foreground">Actual arrival</dt>
            <dd class="font-medium">{formatTime(flight.actualArrival)}</dd>
          </div>
        {/if}
        <div class="flex justify-between">
          <dt class="text-muted-foreground">Last updated</dt>
          <dd class="text-muted-foreground">{formatDateTime(flight.updatedAt)}</dd>
        </div>
      </dl>
    </div>
  </div>

  <!-- Status history -->
  {#if statusHistory.length > 0}
    <div class="rounded-lg border bg-card p-4 mb-6">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Status History</h2>
      <ol class="relative border-l border-border ml-2 space-y-4">
        {#each statusHistory as entry (entry.id)}
          <li class="pl-5 relative">
            <span class="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary border-2 border-background"></span>
            <p class="text-sm font-medium">{entry.statusMessage}</p>
            <p class="text-xs text-muted-foreground">
              {formatDateTime(entry.statusTimestamp)}
              <span class="ml-2 rounded border px-1 py-0.5 text-[10px] uppercase tracking-wide">{entry.source}</span>
            </p>
          </li>
        {/each}
      </ol>
    </div>
  {/if}
</div>
