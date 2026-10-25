# Weather data: Open-Meteo

The sim's weather (Options → Weather) comes from [Open-Meteo](https://open-meteo.com/), fetched in the browser only while weather is on. No key; the free tier is for non-commercial use, 10,000 calls a day, 5,000 an hour and 600 a minute per IP. A call is one location with up to 10 variables over up to two weeks; more counts fractionally (a location with 11 variables is 1.1 calls).

Licence: **CC BY 4.0**, attribution "Weather data by Open-Meteo.com" (shown in Options → Data & credits with the model the day came from, and in the Weather tab). The data is never stored in the repo except the test fixtures in `sim/e2e/fixtures` (CC BY 4.0, recorded from the API).

| API | URL | Data | Resolution | Coverage |
|---|---|---|---|---|
| Forecast | `https://api.open-meteo.com/v1/forecast` | Weather models, the last week and today | Model's (1–25 km), hourly | Global |
| Historical Forecast | `https://historical-forecast-api.open-meteo.com/v1/forecast` | Archived runs of the forecast models, the first hours of each run stitched together | Météo-France AROME 1.5–2.5 km (from 2022-11-13), DWD ICON-D2 2 km (from 2022-11-24), MeteoSwiss ICON-CH1 1 km (from 2025-07-29), others; hourly | Each model's domain; best match global, complete from late 2022 |
| Historical Weather | `https://archive-api.open-meteo.com/v1/archive` | ERA5 / ERA5-Land reanalysis | ~25 km / ~9 km, hourly, ~5 days behind | Global, 1940 on |

What the sim asks for (`sim/src/env/weather-source.ts`, `weather-field.ts`): per resort-day, a grid of up to 45 points over the lifts at their ground heights plus a column of 5 heights at the centre, in one request (temperature, humidity, precipitation, snowfall, low/mid/high cloud, wind speed, direction and gusts; forecasts add visibility); for model days, cloud cover and geopotential height at 900–500 hPa over 5 of the points in a second. About 50–60 calls a resort-day, cached in localStorage.

Variable availability differs by model and date: AROME's archive had no pressure levels or visibility in early 2023 (the sim then asks the best match for pressure levels), the `*_seamless` ids fill a high-resolution model's missing variables from the same provider's coarser models, and a model outside its domain or before its archive answers with nulls (the sim then falls back to the next source).
