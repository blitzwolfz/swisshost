import React, { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";

const LiveMapPage = lazy(() => import("./pages/LiveMapPage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const InstallPage = lazy(() => import("./pages/InstallPage"));
const RoutesPage = lazy(() => import("./pages/RoutesPage").then((m) => ({ default: m.RoutesPage })));
const RouteDetailPage = lazy(() => import("./pages/RoutesPage").then((m) => ({ default: m.RouteDetailPage })));
const VehiclesPage = lazy(() => import("./pages/VehiclesPage").then((m) => ({ default: m.VehiclesPage })));
const VehicleDetailPage = lazy(() => import("./pages/VehiclesPage").then((m) => ({ default: m.VehicleDetailPage })));
const StopsPage = lazy(() => import("./pages/StopsPage").then((m) => ({ default: m.StopsPage })));
const StopDetailPage = lazy(() => import("./pages/StopsPage").then((m) => ({ default: m.StopDetailPage })));
const TripDetailPage = lazy(() => import("./pages/TripBlockPages").then((m) => ({ default: m.TripDetailPage })));
const BlockDetailPage = lazy(() => import("./pages/TripBlockPages").then((m) => ({ default: m.BlockDetailPage })));
const AlertsPage = lazy(() => import("./pages/UtilityPages").then((m) => ({ default: m.AlertsPage })));
const StatusPage = lazy(() => import("./pages/UtilityPages").then((m) => ({ default: m.StatusPage })));
const FavoritesPage = lazy(() => import("./pages/UtilityPages").then((m) => ({ default: m.FavoritesPage })));
const AccountPage = lazy(() => import("./pages/UtilityPages").then((m) => ({ default: m.AccountPage })));

function PageFallback() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-8 text-sm" style={{ color: "var(--text-muted)" }}>
      Loading…
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route
            index
            element={
              <Suspense fallback={<PageFallback />}>
                <LiveMapPage />
              </Suspense>
            }
          />
          <Route path="/map" element={<Navigate to="/" replace />} />
          <Route
            path="/routes"
            element={
              <Suspense fallback={<PageFallback />}>
                <RoutesPage />
              </Suspense>
            }
          />
          <Route
            path="/routes/:agencyId/:routeId"
            element={
              <Suspense fallback={<PageFallback />}>
                <RouteDetailPage />
              </Suspense>
            }
          />
          <Route
            path="/vehicles"
            element={
              <Suspense fallback={<PageFallback />}>
                <VehiclesPage />
              </Suspense>
            }
          />
          <Route
            path="/vehicles/:agencyId/:vehicleId"
            element={
              <Suspense fallback={<PageFallback />}>
                <VehicleDetailPage />
              </Suspense>
            }
          />
          <Route
            path="/stops"
            element={
              <Suspense fallback={<PageFallback />}>
                <StopsPage />
              </Suspense>
            }
          />
          <Route
            path="/stops/:agencyId/:stopId"
            element={
              <Suspense fallback={<PageFallback />}>
                <StopDetailPage />
              </Suspense>
            }
          />
          <Route
            path="/history"
            element={
              <Suspense fallback={<PageFallback />}>
                <HistoryPage />
              </Suspense>
            }
          />
          <Route
            path="/trips/:agencyId/:tripId"
            element={
              <Suspense fallback={<PageFallback />}>
                <TripDetailPage />
              </Suspense>
            }
          />
          <Route
            path="/blocks/:agencyId/:blockId"
            element={
              <Suspense fallback={<PageFallback />}>
                <BlockDetailPage />
              </Suspense>
            }
          />
          <Route
            path="/alerts"
            element={
              <Suspense fallback={<PageFallback />}>
                <AlertsPage />
              </Suspense>
            }
          />
          <Route
            path="/status"
            element={
              <Suspense fallback={<PageFallback />}>
                <StatusPage />
              </Suspense>
            }
          />
          <Route
            path="/favorites"
            element={
              <Suspense fallback={<PageFallback />}>
                <FavoritesPage />
              </Suspense>
            }
          />
          <Route
            path="/account"
            element={
              <Suspense fallback={<PageFallback />}>
                <AccountPage />
              </Suspense>
            }
          />
          <Route
            path="/install"
            element={
              <Suspense fallback={<PageFallback />}>
                <InstallPage />
              </Suspense>
            }
          />
          <Route
            path="/admin"
            element={
              <Suspense fallback={<PageFallback />}>
                <AdminPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
