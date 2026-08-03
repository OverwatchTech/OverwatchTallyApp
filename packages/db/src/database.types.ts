// Generated from Supabase (project lropxenygvybctvaspxm) — do not edit by hand.
// Regenerate after each migration.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      alert_rules: {
        Row: {
          created_at: string
          enabled: boolean
          escalation: Json | null
          farm_id: string
          id: string
          kind: Database["public"]["Enums"]["alert_kind_t"]
          org_id: string
          params: Json
          quiet_hours: Json | null
          severity: Database["public"]["Enums"]["severity_t"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          escalation?: Json | null
          farm_id: string
          id?: string
          kind: Database["public"]["Enums"]["alert_kind_t"]
          org_id: string
          params?: Json
          quiet_hours?: Json | null
          severity?: Database["public"]["Enums"]["severity_t"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          escalation?: Json | null
          farm_id?: string
          id?: string
          kind?: Database["public"]["Enums"]["alert_kind_t"]
          org_id?: string
          params?: Json
          quiet_hours?: Json | null
          severity?: Database["public"]["Enums"]["severity_t"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_rules_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alert_rules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          dedup_key: string
          deliveries: Json
          details: Json | null
          farm_id: string
          id: string
          kind: Database["public"]["Enums"]["alert_kind_t"]
          opened_at: string
          org_id: string
          resolved_at: string | null
          rule_id: string | null
          severity: Database["public"]["Enums"]["severity_t"]
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          dedup_key: string
          deliveries?: Json
          details?: Json | null
          farm_id: string
          id?: string
          kind: Database["public"]["Enums"]["alert_kind_t"]
          opened_at?: string
          org_id: string
          resolved_at?: string | null
          rule_id?: string | null
          severity: Database["public"]["Enums"]["severity_t"]
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          dedup_key?: string
          deliveries?: Json
          details?: Json | null
          farm_id?: string
          id?: string
          kind?: Database["public"]["Enums"]["alert_kind_t"]
          opened_at?: string
          org_id?: string
          resolved_at?: string | null
          rule_id?: string | null
          severity?: Database["public"]["Enums"]["severity_t"]
        }
        Relationships: [
          {
            foreignKeyName: "alerts_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "alert_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_platform_role: string | null
          actor_user_id: string | null
          created_at: string
          details: Json | null
          farm_id: string | null
          id: number
          impersonation_expires_at: string | null
          org_id: string | null
          reason: string | null
          record_id: string | null
          table_name: string | null
        }
        Insert: {
          action: string
          actor_platform_role?: string | null
          actor_user_id?: string | null
          created_at?: string
          details?: Json | null
          farm_id?: string | null
          id?: number
          impersonation_expires_at?: string | null
          org_id?: string | null
          reason?: string | null
          record_id?: string | null
          table_name?: string | null
        }
        Update: {
          action?: string
          actor_platform_role?: string | null
          actor_user_id?: string | null
          created_at?: string
          details?: Json | null
          farm_id?: string | null
          id?: number
          impersonation_expires_at?: string | null
          org_id?: string | null
          reason?: string | null
          record_id?: string | null
          table_name?: string | null
        }
        Relationships: []
      }
      bale_movements: {
        Row: {
          delta: number
          farm_id: string
          feed_event_id: string | null
          feed_inventory_id: string
          id: string
          occurred_at: string
          org_id: string
          reason: Database["public"]["Enums"]["bale_reason_t"]
          recorded_by: string | null
        }
        Insert: {
          delta: number
          farm_id: string
          feed_event_id?: string | null
          feed_inventory_id: string
          id?: string
          occurred_at?: string
          org_id: string
          reason: Database["public"]["Enums"]["bale_reason_t"]
          recorded_by?: string | null
        }
        Update: {
          delta?: number
          farm_id?: string
          feed_event_id?: string | null
          feed_inventory_id?: string
          id?: string
          occurred_at?: string
          org_id?: string
          reason?: Database["public"]["Enums"]["bale_reason_t"]
          recorded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bale_movements_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bale_movements_feed_event_id_fkey"
            columns: ["feed_event_id"]
            isOneToOne: false
            referencedRelation: "feed_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bale_movements_feed_inventory_id_fkey"
            columns: ["feed_inventory_id"]
            isOneToOne: false
            referencedRelation: "feed_inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bale_movements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      bale_types: {
        Row: {
          created_at: string
          dim_a_m: number | null
          dim_b_m: number | null
          dim_c_m: number | null
          farm_id: string | null
          footprint_m2: number | null
          id: string
          label: string
          nominal_weight_kg: number
          org_id: string | null
          shape: Database["public"]["Enums"]["bale_shape_t"]
        }
        Insert: {
          created_at?: string
          dim_a_m?: number | null
          dim_b_m?: number | null
          dim_c_m?: number | null
          farm_id?: string | null
          footprint_m2?: number | null
          id?: string
          label: string
          nominal_weight_kg: number
          org_id?: string | null
          shape: Database["public"]["Enums"]["bale_shape_t"]
        }
        Update: {
          created_at?: string
          dim_a_m?: number | null
          dim_b_m?: number | null
          dim_c_m?: number | null
          farm_id?: string | null
          footprint_m2?: number | null
          id?: string
          label?: string
          nominal_weight_kg?: number
          org_id?: string | null
          shape?: Database["public"]["Enums"]["bale_shape_t"]
        }
        Relationships: [
          {
            foreignKeyName: "bale_types_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bale_types_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      dead_letter_events: {
        Row: {
          created_at: string
          error: string
          error_detail: Json | null
          farm_id: string
          id: number
          mdp_event_id: string | null
          org_id: string
          raw_event_id: number | null
          resolved_at: string | null
          resolved_by: string | null
          retry_count: number
        }
        Insert: {
          created_at?: string
          error: string
          error_detail?: Json | null
          farm_id: string
          id?: number
          mdp_event_id?: string | null
          org_id: string
          raw_event_id?: number | null
          resolved_at?: string | null
          resolved_by?: string | null
          retry_count?: number
        }
        Update: {
          created_at?: string
          error?: string
          error_detail?: Json | null
          farm_id?: string
          id?: number
          mdp_event_id?: string | null
          org_id?: string
          raw_event_id?: number | null
          resolved_at?: string | null
          resolved_by?: string | null
          retry_count?: number
        }
        Relationships: []
      }
      device_calibrations: {
        Row: {
          created_at: string
          created_by: string | null
          curve: Json
          device_id: string
          effective_from: string
          id: string
          org_id: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          curve: Json
          device_id: string
          effective_from?: string
          id?: string
          org_id: string
          version: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          curve?: Json
          device_id?: string
          effective_from?: string
          id?: string
          org_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "device_calibrations_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_calibrations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      device_health: {
        Row: {
          battery_pct: number | null
          battery_trend: Json | null
          device_id: string
          expected_interval_s: number | null
          farm_id: string
          last_online_change_at: string | null
          last_seen_at: string | null
          online: boolean | null
          org_id: string
          updated_at: string
        }
        Insert: {
          battery_pct?: number | null
          battery_trend?: Json | null
          device_id: string
          expected_interval_s?: number | null
          farm_id: string
          last_online_change_at?: string | null
          last_seen_at?: string | null
          online?: boolean | null
          org_id: string
          updated_at?: string
        }
        Update: {
          battery_pct?: number | null
          battery_trend?: Json | null
          device_id?: string
          expected_interval_s?: number | null
          farm_id?: string
          last_online_change_at?: string | null
          last_seen_at?: string | null
          online?: boolean | null
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_health_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: true
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          battery_pct: number | null
          created_at: string
          dev_eui: string
          farm_id: string
          firmware: string | null
          id: string
          install_date: string | null
          install_photo_path: string | null
          installer_user_id: string | null
          last_seen_at: string | null
          mdp_device_id: string | null
          model: string
          mounted_on: string | null
          org_id: string
          role: Database["public"]["Enums"]["device_role_t"]
          sn: string | null
          status: Database["public"]["Enums"]["device_status_t"]
          updated_at: string
        }
        Insert: {
          battery_pct?: number | null
          created_at?: string
          dev_eui: string
          farm_id: string
          firmware?: string | null
          id?: string
          install_date?: string | null
          install_photo_path?: string | null
          installer_user_id?: string | null
          last_seen_at?: string | null
          mdp_device_id?: string | null
          model: string
          mounted_on?: string | null
          org_id: string
          role: Database["public"]["Enums"]["device_role_t"]
          sn?: string | null
          status?: Database["public"]["Enums"]["device_status_t"]
          updated_at?: string
        }
        Update: {
          battery_pct?: number | null
          created_at?: string
          dev_eui?: string
          farm_id?: string
          firmware?: string | null
          id?: string
          install_date?: string | null
          install_photo_path?: string | null
          installer_user_id?: string | null
          last_seen_at?: string | null
          mdp_device_id?: string | null
          model?: string
          mounted_on?: string | null
          org_id?: string
          role?: Database["public"]["Enums"]["device_role_t"]
          sn?: string | null
          status?: Database["public"]["Enums"]["device_status_t"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "devices_mounted_on_fkey"
            columns: ["mounted_on"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "devices_mounted_on_fkey"
            columns: ["mounted_on"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "devices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      farm_bale_calibrations: {
        Row: {
          bale_type_id: string
          farm_id: string
          id: string
          measured_at: string
          measured_weight_kg: number
          method: string
          notes: string | null
          org_id: string
        }
        Insert: {
          bale_type_id: string
          farm_id: string
          id?: string
          measured_at?: string
          measured_weight_kg: number
          method?: string
          notes?: string | null
          org_id: string
        }
        Update: {
          bale_type_id?: string
          farm_id?: string
          id?: string
          measured_at?: string
          measured_weight_kg?: number
          method?: string
          notes?: string | null
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "farm_bale_calibrations_bale_type_id_fkey"
            columns: ["bale_type_id"]
            isOneToOne: false
            referencedRelation: "bale_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "farm_bale_calibrations_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "farm_bale_calibrations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      farms: {
        Row: {
          boundary: unknown
          centroid: unknown
          created_at: string
          id: string
          mdp_access_token_encrypted: string | null
          mdp_application_id: string | null
          mdp_group_id: string | null
          name: string
          org_id: string
          parcel_apn: string | null
          status: Database["public"]["Enums"]["farm_status_t"]
          subscription_tier: Database["public"]["Enums"]["tier_t"] | null
          timezone: string
          updated_at: string
          webhook_token: string
        }
        Insert: {
          boundary?: unknown
          centroid?: unknown
          created_at?: string
          id?: string
          mdp_access_token_encrypted?: string | null
          mdp_application_id?: string | null
          mdp_group_id?: string | null
          name: string
          org_id: string
          parcel_apn?: string | null
          status?: Database["public"]["Enums"]["farm_status_t"]
          subscription_tier?: Database["public"]["Enums"]["tier_t"] | null
          timezone?: string
          updated_at?: string
          webhook_token?: string
        }
        Update: {
          boundary?: unknown
          centroid?: unknown
          created_at?: string
          id?: string
          mdp_access_token_encrypted?: string | null
          mdp_application_id?: string | null
          mdp_group_id?: string | null
          name?: string
          org_id?: string
          parcel_apn?: string | null
          status?: Database["public"]["Enums"]["farm_status_t"]
          subscription_tier?: Database["public"]["Enums"]["tier_t"] | null
          timezone?: string
          updated_at?: string
          webhook_token?: string
        }
        Relationships: [
          {
            foreignKeyName: "farms_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_links: {
        Row: {
          created_at: string
          farm_id: string
          from_feature_id: string
          id: string
          org_id: string
          relation: Database["public"]["Enums"]["link_relation_t"]
          to_feature_id: string
          via_feature_id: string | null
        }
        Insert: {
          created_at?: string
          farm_id: string
          from_feature_id: string
          id?: string
          org_id: string
          relation: Database["public"]["Enums"]["link_relation_t"]
          to_feature_id: string
          via_feature_id?: string | null
        }
        Update: {
          created_at?: string
          farm_id?: string
          from_feature_id?: string
          id?: string
          org_id?: string
          relation?: Database["public"]["Enums"]["link_relation_t"]
          to_feature_id?: string
          via_feature_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feature_links_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_links_from_feature_id_fkey"
            columns: ["from_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_links_from_feature_id_fkey"
            columns: ["from_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_links_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_links_to_feature_id_fkey"
            columns: ["to_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_links_to_feature_id_fkey"
            columns: ["to_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_links_via_feature_id_fkey"
            columns: ["via_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feature_links_via_feature_id_fkey"
            columns: ["via_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
        ]
      }
      feed_events: {
        Row: {
          amount_kg: number | null
          confidence: number | null
          farm_id: string
          group_id: string | null
          id: string
          occurred_at: string
          org_id: string
          pen_feature_id: string | null
          ration_id: string | null
          recorded_by: string | null
          source: Database["public"]["Enums"]["feed_source_t"]
        }
        Insert: {
          amount_kg?: number | null
          confidence?: number | null
          farm_id: string
          group_id?: string | null
          id?: string
          occurred_at?: string
          org_id: string
          pen_feature_id?: string | null
          ration_id?: string | null
          recorded_by?: string | null
          source: Database["public"]["Enums"]["feed_source_t"]
        }
        Update: {
          amount_kg?: number | null
          confidence?: number | null
          farm_id?: string
          group_id?: string | null
          id?: string
          occurred_at?: string
          org_id?: string
          pen_feature_id?: string | null
          ration_id?: string | null
          recorded_by?: string | null
          source?: Database["public"]["Enums"]["feed_source_t"]
        }
        Relationships: [
          {
            foreignKeyName: "feed_events_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_events_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_events_pen_feature_id_fkey"
            columns: ["pen_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_events_pen_feature_id_fkey"
            columns: ["pen_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
        ]
      }
      feed_inventory: {
        Row: {
          bale_count: number
          bale_type_id: string | null
          confidence: number | null
          cost_basis: Database["public"]["Enums"]["cost_basis_t"] | null
          count_source: Database["public"]["Enums"]["count_source_t"] | null
          created_at: string
          crude_protein_pct: number | null
          cutting: number | null
          dry_matter_pct: number
          farm_id: string
          feed_type: Database["public"]["Enums"]["feed_type_t"]
          id: string
          map_feature_id: string | null
          org_id: string
          rfv: number | null
          satellite_count: number | null
          satellite_counted_at: string | null
          tdn_pct: number | null
          tiers: number | null
          unit_cost: number | null
          updated_at: string
        }
        Insert: {
          bale_count?: number
          bale_type_id?: string | null
          confidence?: number | null
          cost_basis?: Database["public"]["Enums"]["cost_basis_t"] | null
          count_source?: Database["public"]["Enums"]["count_source_t"] | null
          created_at?: string
          crude_protein_pct?: number | null
          cutting?: number | null
          dry_matter_pct?: number
          farm_id: string
          feed_type: Database["public"]["Enums"]["feed_type_t"]
          id?: string
          map_feature_id?: string | null
          org_id: string
          rfv?: number | null
          satellite_count?: number | null
          satellite_counted_at?: string | null
          tdn_pct?: number | null
          tiers?: number | null
          unit_cost?: number | null
          updated_at?: string
        }
        Update: {
          bale_count?: number
          bale_type_id?: string | null
          confidence?: number | null
          cost_basis?: Database["public"]["Enums"]["cost_basis_t"] | null
          count_source?: Database["public"]["Enums"]["count_source_t"] | null
          created_at?: string
          crude_protein_pct?: number | null
          cutting?: number | null
          dry_matter_pct?: number
          farm_id?: string
          feed_type?: Database["public"]["Enums"]["feed_type_t"]
          id?: string
          map_feature_id?: string | null
          org_id?: string
          rfv?: number | null
          satellite_count?: number | null
          satellite_counted_at?: string | null
          tdn_pct?: number | null
          tiers?: number | null
          unit_cost?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "feed_inventory_bale_type_id_fkey"
            columns: ["bale_type_id"]
            isOneToOne: false
            referencedRelation: "bale_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_inventory_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_inventory_map_feature_id_fkey"
            columns: ["map_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_inventory_map_feature_id_fkey"
            columns: ["map_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_inventory_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      feed_schedules: {
        Row: {
          active: boolean
          assigned_crew: string[]
          created_at: string
          farm_id: string
          grace_minutes: number
          group_id: string | null
          id: string
          org_id: string
          pen_feature_id: string | null
          ration_id: string | null
          target_kg: number | null
          updated_at: string
          windows: Json
        }
        Insert: {
          active?: boolean
          assigned_crew?: string[]
          created_at?: string
          farm_id: string
          grace_minutes?: number
          group_id?: string | null
          id?: string
          org_id: string
          pen_feature_id?: string | null
          ration_id?: string | null
          target_kg?: number | null
          updated_at?: string
          windows?: Json
        }
        Update: {
          active?: boolean
          assigned_crew?: string[]
          created_at?: string
          farm_id?: string
          grace_minutes?: number
          group_id?: string | null
          id?: string
          org_id?: string
          pen_feature_id?: string | null
          ration_id?: string | null
          target_kg?: number | null
          updated_at?: string
          windows?: Json
        }
        Relationships: [
          {
            foreignKeyName: "feed_schedules_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_schedules_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_schedules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_schedules_pen_feature_id_fkey"
            columns: ["pen_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_schedules_pen_feature_id_fkey"
            columns: ["pen_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
        ]
      }
      gate_events: {
        Row: {
          attributed_to: string | null
          attribution_confidence: number | null
          device_id: string | null
          duration_s: number | null
          farm_id: string
          gate_feature_id: string | null
          id: string
          occurred_at: string
          org_id: string
          state: Database["public"]["Enums"]["gate_state_t"]
        }
        Insert: {
          attributed_to?: string | null
          attribution_confidence?: number | null
          device_id?: string | null
          duration_s?: number | null
          farm_id: string
          gate_feature_id?: string | null
          id?: string
          occurred_at: string
          org_id: string
          state: Database["public"]["Enums"]["gate_state_t"]
        }
        Update: {
          attributed_to?: string | null
          attribution_confidence?: number | null
          device_id?: string | null
          duration_s?: number | null
          farm_id?: string
          gate_feature_id?: string | null
          id?: string
          occurred_at?: string
          org_id?: string
          state?: Database["public"]["Enums"]["gate_state_t"]
        }
        Relationships: [
          {
            foreignKeyName: "gate_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gate_events_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gate_events_gate_feature_id_fkey"
            columns: ["gate_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gate_events_gate_feature_id_fkey"
            columns: ["gate_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gate_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      gateways: {
        Row: {
          auto_provision: boolean
          backhaul: Database["public"]["Enums"]["backhaul_t"] | null
          created_at: string
          farm_id: string
          firmware: string | null
          gateway_eui: string | null
          gateway_sn: string
          id: string
          install_feature_id: string | null
          last_seen_at: string | null
          model: Database["public"]["Enums"]["gateway_model_t"]
          org_id: string
          updated_at: string
        }
        Insert: {
          auto_provision?: boolean
          backhaul?: Database["public"]["Enums"]["backhaul_t"] | null
          created_at?: string
          farm_id: string
          firmware?: string | null
          gateway_eui?: string | null
          gateway_sn: string
          id?: string
          install_feature_id?: string | null
          last_seen_at?: string | null
          model: Database["public"]["Enums"]["gateway_model_t"]
          org_id: string
          updated_at?: string
        }
        Update: {
          auto_provision?: boolean
          backhaul?: Database["public"]["Enums"]["backhaul_t"] | null
          created_at?: string
          farm_id?: string
          firmware?: string | null
          gateway_eui?: string | null
          gateway_sn?: string
          id?: string
          install_feature_id?: string | null
          last_seen_at?: string | null
          model?: Database["public"]["Enums"]["gateway_model_t"]
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gateways_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gateways_install_feature_id_fkey"
            columns: ["install_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gateways_install_feature_id_fkey"
            columns: ["install_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gateways_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      group_placements: {
        Row: {
          created_at: string
          farm_id: string
          group_id: string
          id: string
          org_id: string
          pen_feature_id: string
          valid: unknown
        }
        Insert: {
          created_at?: string
          farm_id: string
          group_id: string
          id?: string
          org_id: string
          pen_feature_id: string
          valid?: unknown
        }
        Update: {
          created_at?: string
          farm_id?: string
          group_id?: string
          id?: string
          org_id?: string
          pen_feature_id?: string
          valid?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "group_placements_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_placements_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_placements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_placements_pen_feature_id_fkey"
            columns: ["pen_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_placements_pen_feature_id_fkey"
            columns: ["pen_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          arrival_date: string | null
          avg_weight_kg: number | null
          class: string | null
          created_at: string
          farm_id: string
          id: string
          name: string
          notes: string | null
          org_id: string
          species: string | null
          target_ration_id: string | null
          updated_at: string
        }
        Insert: {
          arrival_date?: string | null
          avg_weight_kg?: number | null
          class?: string | null
          created_at?: string
          farm_id: string
          id?: string
          name: string
          notes?: string | null
          org_id: string
          species?: string | null
          target_ration_id?: string | null
          updated_at?: string
        }
        Update: {
          arrival_date?: string | null
          avg_weight_kg?: number | null
          class?: string | null
          created_at?: string
          farm_id?: string
          id?: string
          name?: string
          notes?: string | null
          org_id?: string
          species?: string | null
          target_ration_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "groups_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "groups_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      hardware_orders: {
        Row: {
          assigned_installer: string | null
          farm_id: string | null
          id: string
          installed_at: string | null
          invoiced_at: string | null
          line_items: Json
          live_at: string | null
          notes: string | null
          org_id: string
          paid_at: string | null
          quoted_at: string
          shipped_at: string | null
          status: Database["public"]["Enums"]["order_status_t"]
          stripe_invoice_id: string | null
          updated_at: string
        }
        Insert: {
          assigned_installer?: string | null
          farm_id?: string | null
          id?: string
          installed_at?: string | null
          invoiced_at?: string | null
          line_items?: Json
          live_at?: string | null
          notes?: string | null
          org_id: string
          paid_at?: string | null
          quoted_at?: string
          shipped_at?: string | null
          status?: Database["public"]["Enums"]["order_status_t"]
          stripe_invoice_id?: string | null
          updated_at?: string
        }
        Update: {
          assigned_installer?: string | null
          farm_id?: string | null
          id?: string
          installed_at?: string | null
          invoiced_at?: string | null
          line_items?: Json
          live_at?: string | null
          notes?: string | null
          org_id?: string
          paid_at?: string | null
          quoted_at?: string
          shipped_at?: string | null
          status?: Database["public"]["Enums"]["order_status_t"]
          stripe_invoice_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hardware_orders_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_orders_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      head_count_events: {
        Row: {
          delta: number
          farm_id: string
          group_id: string
          id: string
          notes: string | null
          occurred_at: string
          org_id: string
          reason: Database["public"]["Enums"]["head_reason_t"]
          recorded_by: string | null
        }
        Insert: {
          delta: number
          farm_id: string
          group_id: string
          id?: string
          notes?: string | null
          occurred_at?: string
          org_id: string
          reason: Database["public"]["Enums"]["head_reason_t"]
          recorded_by?: string | null
        }
        Update: {
          delta?: number
          farm_id?: string
          group_id?: string
          id?: string
          notes?: string | null
          occurred_at?: string
          org_id?: string
          reason?: Database["public"]["Enums"]["head_reason_t"]
          recorded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "head_count_events_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "head_count_events_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "head_count_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      ingest_event_ids: {
        Row: {
          farm_id: string
          mdp_event_id: string
          received_at: string
        }
        Insert: {
          farm_id: string
          mdp_event_id: string
          received_at?: string
        }
        Update: {
          farm_id?: string
          mdp_event_id?: string
          received_at?: string
        }
        Relationships: []
      }
      map_features: {
        Row: {
          ai_original_geom: unknown
          area_m2: number | null
          capacity_head: number | null
          confidence: number | null
          created_at: string
          farm_id: string
          geom: unknown
          id: string
          kind: Database["public"]["Enums"]["feature_kind_t"]
          name: string
          notes: string | null
          org_id: string
          perimeter_m: number | null
          restrictions: string | null
          source: Database["public"]["Enums"]["feature_source_t"]
          species: string | null
          updated_at: string
        }
        Insert: {
          ai_original_geom?: unknown
          area_m2?: number | null
          capacity_head?: number | null
          confidence?: number | null
          created_at?: string
          farm_id: string
          geom: unknown
          id?: string
          kind: Database["public"]["Enums"]["feature_kind_t"]
          name: string
          notes?: string | null
          org_id: string
          perimeter_m?: number | null
          restrictions?: string | null
          source?: Database["public"]["Enums"]["feature_source_t"]
          species?: string | null
          updated_at?: string
        }
        Update: {
          ai_original_geom?: unknown
          area_m2?: number | null
          capacity_head?: number | null
          confidence?: number | null
          created_at?: string
          farm_id?: string
          geom?: unknown
          id?: string
          kind?: Database["public"]["Enums"]["feature_kind_t"]
          name?: string
          notes?: string | null
          org_id?: string
          perimeter_m?: number | null
          restrictions?: string | null
          source?: Database["public"]["Enums"]["feature_source_t"]
          species?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "map_features_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "map_features_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          created_at: string
          org_id: string
          role: Database["public"]["Enums"]["member_role_t"]
          user_id: string
        }
        Insert: {
          created_at?: string
          org_id: string
          role: Database["public"]["Enums"]["member_role_t"]
          user_id: string
        }
        Update: {
          created_at?: string
          org_id?: string
          role?: Database["public"]["Enums"]["member_role_t"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          billing_contact_name: string | null
          billing_email: string | null
          created_at: string
          id: string
          name: string
          status: Database["public"]["Enums"]["org_status_t"]
          stripe_customer_id: string | null
          updated_at: string
        }
        Insert: {
          billing_contact_name?: string | null
          billing_email?: string | null
          created_at?: string
          id?: string
          name: string
          status?: Database["public"]["Enums"]["org_status_t"]
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Update: {
          billing_contact_name?: string | null
          billing_email?: string | null
          created_at?: string
          id?: string
          name?: string
          status?: Database["public"]["Enums"]["org_status_t"]
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      raw_events: {
        Row: {
          envelope: Json
          event_type: string
          farm_id: string
          id: number
          mdp_event_id: string
          org_id: string
          processed_at: string | null
          received_at: string
          status: Database["public"]["Enums"]["raw_status_t"]
        }
        Insert: {
          envelope: Json
          event_type: string
          farm_id: string
          id?: number
          mdp_event_id: string
          org_id: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Update: {
          envelope?: Json
          event_type?: string
          farm_id?: string
          id?: number
          mdp_event_id?: string
          org_id?: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Relationships: []
      }
      raw_events_202608: {
        Row: {
          envelope: Json
          event_type: string
          farm_id: string
          id: number
          mdp_event_id: string
          org_id: string
          processed_at: string | null
          received_at: string
          status: Database["public"]["Enums"]["raw_status_t"]
        }
        Insert: {
          envelope: Json
          event_type: string
          farm_id: string
          id?: number
          mdp_event_id: string
          org_id: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Update: {
          envelope?: Json
          event_type?: string
          farm_id?: string
          id?: number
          mdp_event_id?: string
          org_id?: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Relationships: []
      }
      raw_events_202609: {
        Row: {
          envelope: Json
          event_type: string
          farm_id: string
          id: number
          mdp_event_id: string
          org_id: string
          processed_at: string | null
          received_at: string
          status: Database["public"]["Enums"]["raw_status_t"]
        }
        Insert: {
          envelope: Json
          event_type: string
          farm_id: string
          id?: number
          mdp_event_id: string
          org_id: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Update: {
          envelope?: Json
          event_type?: string
          farm_id?: string
          id?: number
          mdp_event_id?: string
          org_id?: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Relationships: []
      }
      raw_events_202610: {
        Row: {
          envelope: Json
          event_type: string
          farm_id: string
          id: number
          mdp_event_id: string
          org_id: string
          processed_at: string | null
          received_at: string
          status: Database["public"]["Enums"]["raw_status_t"]
        }
        Insert: {
          envelope: Json
          event_type: string
          farm_id: string
          id?: number
          mdp_event_id: string
          org_id: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Update: {
          envelope?: Json
          event_type?: string
          farm_id?: string
          id?: number
          mdp_event_id?: string
          org_id?: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Relationships: []
      }
      raw_events_202611: {
        Row: {
          envelope: Json
          event_type: string
          farm_id: string
          id: number
          mdp_event_id: string
          org_id: string
          processed_at: string | null
          received_at: string
          status: Database["public"]["Enums"]["raw_status_t"]
        }
        Insert: {
          envelope: Json
          event_type: string
          farm_id: string
          id?: number
          mdp_event_id: string
          org_id: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Update: {
          envelope?: Json
          event_type?: string
          farm_id?: string
          id?: number
          mdp_event_id?: string
          org_id?: string
          processed_at?: string | null
          received_at?: string
          status?: Database["public"]["Enums"]["raw_status_t"]
        }
        Relationships: []
      }
      readings: {
        Row: {
          device_id: string
          event_created_time: string | null
          farm_id: string
          id: number
          mdp_event_id: string | null
          metric: string
          org_id: string
          received_at: string
          value: number | null
          value_text: string | null
        }
        Insert: {
          device_id: string
          event_created_time?: string | null
          farm_id: string
          id?: number
          mdp_event_id?: string | null
          metric: string
          org_id: string
          received_at: string
          value?: number | null
          value_text?: string | null
        }
        Update: {
          device_id?: string
          event_created_time?: string | null
          farm_id?: string
          id?: number
          mdp_event_id?: string | null
          metric?: string
          org_id?: string
          received_at?: string
          value?: number | null
          value_text?: string | null
        }
        Relationships: []
      }
      readings_202608: {
        Row: {
          device_id: string
          event_created_time: string | null
          farm_id: string
          id: number
          mdp_event_id: string | null
          metric: string
          org_id: string
          received_at: string
          value: number | null
          value_text: string | null
        }
        Insert: {
          device_id: string
          event_created_time?: string | null
          farm_id: string
          id?: number
          mdp_event_id?: string | null
          metric: string
          org_id: string
          received_at: string
          value?: number | null
          value_text?: string | null
        }
        Update: {
          device_id?: string
          event_created_time?: string | null
          farm_id?: string
          id?: number
          mdp_event_id?: string | null
          metric?: string
          org_id?: string
          received_at?: string
          value?: number | null
          value_text?: string | null
        }
        Relationships: []
      }
      readings_202609: {
        Row: {
          device_id: string
          event_created_time: string | null
          farm_id: string
          id: number
          mdp_event_id: string | null
          metric: string
          org_id: string
          received_at: string
          value: number | null
          value_text: string | null
        }
        Insert: {
          device_id: string
          event_created_time?: string | null
          farm_id: string
          id?: number
          mdp_event_id?: string | null
          metric: string
          org_id: string
          received_at: string
          value?: number | null
          value_text?: string | null
        }
        Update: {
          device_id?: string
          event_created_time?: string | null
          farm_id?: string
          id?: number
          mdp_event_id?: string | null
          metric?: string
          org_id?: string
          received_at?: string
          value?: number | null
          value_text?: string | null
        }
        Relationships: []
      }
      readings_202610: {
        Row: {
          device_id: string
          event_created_time: string | null
          farm_id: string
          id: number
          mdp_event_id: string | null
          metric: string
          org_id: string
          received_at: string
          value: number | null
          value_text: string | null
        }
        Insert: {
          device_id: string
          event_created_time?: string | null
          farm_id: string
          id?: number
          mdp_event_id?: string | null
          metric: string
          org_id: string
          received_at: string
          value?: number | null
          value_text?: string | null
        }
        Update: {
          device_id?: string
          event_created_time?: string | null
          farm_id?: string
          id?: number
          mdp_event_id?: string | null
          metric?: string
          org_id?: string
          received_at?: string
          value?: number | null
          value_text?: string | null
        }
        Relationships: []
      }
      readings_202611: {
        Row: {
          device_id: string
          event_created_time: string | null
          farm_id: string
          id: number
          mdp_event_id: string | null
          metric: string
          org_id: string
          received_at: string
          value: number | null
          value_text: string | null
        }
        Insert: {
          device_id: string
          event_created_time?: string | null
          farm_id: string
          id?: number
          mdp_event_id?: string | null
          metric: string
          org_id: string
          received_at: string
          value?: number | null
          value_text?: string | null
        }
        Update: {
          device_id?: string
          event_created_time?: string | null
          farm_id?: string
          id?: number
          mdp_event_id?: string | null
          metric?: string
          org_id?: string
          received_at?: string
          value?: number | null
          value_text?: string | null
        }
        Relationships: []
      }
      readings_daily: {
        Row: {
          avg: number | null
          bucket_start: string
          device_id: string
          farm_id: string
          last: number | null
          last_text: string | null
          max: number | null
          metric: string
          min: number | null
          org_id: string
          sample_count: number
          sum: number | null
        }
        Insert: {
          avg?: number | null
          bucket_start: string
          device_id: string
          farm_id: string
          last?: number | null
          last_text?: string | null
          max?: number | null
          metric: string
          min?: number | null
          org_id: string
          sample_count: number
          sum?: number | null
        }
        Update: {
          avg?: number | null
          bucket_start?: string
          device_id?: string
          farm_id?: string
          last?: number | null
          last_text?: string | null
          max?: number | null
          metric?: string
          min?: number | null
          org_id?: string
          sample_count?: number
          sum?: number | null
        }
        Relationships: []
      }
      readings_hourly: {
        Row: {
          avg: number | null
          bucket_start: string
          device_id: string
          farm_id: string
          last: number | null
          last_text: string | null
          max: number | null
          metric: string
          min: number | null
          org_id: string
          sample_count: number
          sum: number | null
        }
        Insert: {
          avg?: number | null
          bucket_start: string
          device_id: string
          farm_id: string
          last?: number | null
          last_text?: string | null
          max?: number | null
          metric: string
          min?: number | null
          org_id: string
          sample_count: number
          sum?: number | null
        }
        Update: {
          avg?: number | null
          bucket_start?: string
          device_id?: string
          farm_id?: string
          last?: number | null
          last_text?: string | null
          max?: number | null
          metric?: string
          min?: number | null
          org_id?: string
          sample_count?: number
          sum?: number | null
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at: string | null
          current_period_end: string | null
          farm_id: string
          id: string
          org_id: string
          status: string
          stripe_subscription_id: string | null
          tier: Database["public"]["Enums"]["tier_t"] | null
          updated_at: string
        }
        Insert: {
          cancel_at?: string | null
          current_period_end?: string | null
          farm_id: string
          id?: string
          org_id: string
          status: string
          stripe_subscription_id?: string | null
          tier?: Database["public"]["Enums"]["tier_t"] | null
          updated_at?: string
        }
        Update: {
          cancel_at?: string | null
          current_period_end?: string | null
          farm_id?: string
          id?: string
          org_id?: string
          status?: string
          stripe_subscription_id?: string | null
          tier?: Database["public"]["Enums"]["tier_t"] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      tracker_positions: {
        Row: {
          farm_id: string
          geom: unknown
          hdop: number | null
          heading_deg: number | null
          id: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps: number | null
          tracker_id: string
        }
        Insert: {
          farm_id: string
          geom: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id: string
        }
        Update: {
          farm_id?: string
          geom?: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id?: string
          recorded_at?: string
          source?: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id?: string
        }
        Relationships: []
      }
      tracker_positions_202608: {
        Row: {
          farm_id: string
          geom: unknown
          hdop: number | null
          heading_deg: number | null
          id: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps: number | null
          tracker_id: string
        }
        Insert: {
          farm_id: string
          geom: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id: string
        }
        Update: {
          farm_id?: string
          geom?: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id?: string
          recorded_at?: string
          source?: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id?: string
        }
        Relationships: []
      }
      tracker_positions_202609: {
        Row: {
          farm_id: string
          geom: unknown
          hdop: number | null
          heading_deg: number | null
          id: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps: number | null
          tracker_id: string
        }
        Insert: {
          farm_id: string
          geom: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id: string
        }
        Update: {
          farm_id?: string
          geom?: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id?: string
          recorded_at?: string
          source?: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id?: string
        }
        Relationships: []
      }
      tracker_positions_202610: {
        Row: {
          farm_id: string
          geom: unknown
          hdop: number | null
          heading_deg: number | null
          id: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps: number | null
          tracker_id: string
        }
        Insert: {
          farm_id: string
          geom: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id: string
        }
        Update: {
          farm_id?: string
          geom?: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id?: string
          recorded_at?: string
          source?: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id?: string
        }
        Relationships: []
      }
      tracker_positions_202611: {
        Row: {
          farm_id: string
          geom: unknown
          hdop: number | null
          heading_deg: number | null
          id: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps: number | null
          tracker_id: string
        }
        Insert: {
          farm_id: string
          geom: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id: string
          recorded_at: string
          source: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id: string
        }
        Update: {
          farm_id?: string
          geom?: unknown
          hdop?: number | null
          heading_deg?: number | null
          id?: number
          org_id?: string
          recorded_at?: string
          source?: Database["public"]["Enums"]["tracker_source_t"]
          speed_mps?: number | null
          tracker_id?: string
        }
        Relationships: []
      }
      trackers: {
        Row: {
          created_at: string
          device_id: string | null
          farm_id: string
          id: string
          label: string
          org_id: string
          source: Database["public"]["Enums"]["tracker_source_t"]
        }
        Insert: {
          created_at?: string
          device_id?: string | null
          farm_id: string
          id?: string
          label: string
          org_id: string
          source: Database["public"]["Enums"]["tracker_source_t"]
        }
        Update: {
          created_at?: string
          device_id?: string | null
          farm_id?: string
          id?: string
          label?: string
          org_id?: string
          source?: Database["public"]["Enums"]["tracker_source_t"]
        }
        Relationships: [
          {
            foreignKeyName: "trackers_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trackers_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trackers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      water_events: {
        Row: {
          device_id: string | null
          farm_id: string
          id: string
          interval_range: unknown
          method: Database["public"]["Enums"]["water_method_t"]
          org_id: string
          refill_count: number | null
          temp_c_avg: number | null
          trough_feature_id: string | null
          volume_l: number | null
        }
        Insert: {
          device_id?: string | null
          farm_id: string
          id?: string
          interval_range: unknown
          method: Database["public"]["Enums"]["water_method_t"]
          org_id: string
          refill_count?: number | null
          temp_c_avg?: number | null
          trough_feature_id?: string | null
          volume_l?: number | null
        }
        Update: {
          device_id?: string | null
          farm_id?: string
          id?: string
          interval_range?: unknown
          method?: Database["public"]["Enums"]["water_method_t"]
          org_id?: string
          refill_count?: number | null
          temp_c_avg?: number | null
          trough_feature_id?: string | null
          volume_l?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "water_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_events_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_events_trough_feature_id_fkey"
            columns: ["trough_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "water_events_trough_feature_id_fkey"
            columns: ["trough_feature_id"]
            isOneToOne: false
            referencedRelation: "map_features_geojson"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      group_head_counts: {
        Row: {
          group_id: string | null
          head_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "head_count_events_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      map_features_geojson: {
        Row: {
          area_m2: number | null
          capacity_head: number | null
          confidence: number | null
          farm_id: string | null
          geojson: Json | null
          id: string | null
          kind: Database["public"]["Enums"]["feature_kind_t"] | null
          name: string | null
          org_id: string | null
          perimeter_m: number | null
          restrictions: string | null
          source: Database["public"]["Enums"]["feature_source_t"] | null
          species: string | null
          updated_at: string | null
        }
        Insert: {
          area_m2?: number | null
          capacity_head?: number | null
          confidence?: number | null
          farm_id?: string | null
          geojson?: never
          id?: string | null
          kind?: Database["public"]["Enums"]["feature_kind_t"] | null
          name?: string | null
          org_id?: string | null
          perimeter_m?: number | null
          restrictions?: string | null
          source?: Database["public"]["Enums"]["feature_source_t"] | null
          species?: string | null
          updated_at?: string | null
        }
        Update: {
          area_m2?: number | null
          capacity_head?: number | null
          confidence?: number | null
          farm_id?: string | null
          geojson?: never
          id?: string | null
          kind?: Database["public"]["Enums"]["feature_kind_t"] | null
          name?: string | null
          org_id?: string | null
          perimeter_m?: number | null
          restrictions?: string | null
          source?: Database["public"]["Enums"]["feature_source_t"] | null
          species?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "map_features_farm_id_fkey"
            columns: ["farm_id"]
            isOneToOne: false
            referencedRelation: "farms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "map_features_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      custom_access_token: { Args: { event: Json }; Returns: Json }
    }
    Enums: {
      alert_kind_t:
        | "trough_low"
        | "refill_rate_change"
        | "intake_drop"
        | "schedule_missed"
        | "gate_open_window"
        | "gate_open_duration"
        | "days_on_hand_low"
        | "sensor_offline"
        | "battery_low"
        | "gateway_offline"
      backhaul_t: "ethernet" | "cellular" | "wifi"
      bale_reason_t:
        | "delivered"
        | "baled"
        | "fed"
        | "sold"
        | "spoiled"
        | "correction"
      bale_shape_t: "round" | "large_square" | "small_square"
      cost_basis_t: "per_ton" | "per_bale"
      count_source_t:
        | "satellite_estimated"
        | "hand_counted"
        | "derived_from_feeding"
      device_role_t:
        | "trough_level"
        | "bunk_level"
        | "gate_contact"
        | "water_meter"
        | "controller"
        | "tracker"
      device_status_t: "registered" | "installed" | "live" | "retired"
      farm_status_t: "setup" | "active" | "suspended" | "archived"
      feature_kind_t:
        | "pen"
        | "alley"
        | "feed_lane"
        | "hay_stack"
        | "building"
        | "pasture"
        | "water_source"
        | "trough"
        | "gate"
        | "equipment_zone"
      feature_source_t:
        | "ai_segmented"
        | "parcel_import"
        | "kml_import"
        | "hand_drawn"
      feed_source_t: "sensor_derived" | "crew_logged" | "truck_scale"
      feed_type_t: "alfalfa" | "grass" | "mixed" | "straw" | "commodity"
      gate_state_t: "open" | "closed"
      gateway_model_t: "UG65" | "UG67"
      head_reason_t:
        | "arrival"
        | "birth"
        | "death"
        | "sale"
        | "transfer_in"
        | "transfer_out"
        | "correction"
      link_relation_t: "connects" | "contains" | "adjacent"
      member_role_t: "owner" | "manager" | "crew" | "viewer"
      order_status_t:
        | "quote"
        | "invoiced"
        | "paid"
        | "shipped"
        | "installed"
        | "live"
      org_status_t: "active" | "suspended"
      raw_status_t: "pending" | "normalized" | "dead_letter" | "ignored"
      severity_t: "info" | "warn" | "critical"
      tier_t: "tier_1" | "tier_2" | "tier_3"
      tracker_source_t: "mdp" | "gateway_direct" | "lte_webhook"
      water_method_t: "pulse_count" | "level_drawdown"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      alert_kind_t: [
        "trough_low",
        "refill_rate_change",
        "intake_drop",
        "schedule_missed",
        "gate_open_window",
        "gate_open_duration",
        "days_on_hand_low",
        "sensor_offline",
        "battery_low",
        "gateway_offline",
      ],
      backhaul_t: ["ethernet", "cellular", "wifi"],
      bale_reason_t: [
        "delivered",
        "baled",
        "fed",
        "sold",
        "spoiled",
        "correction",
      ],
      bale_shape_t: ["round", "large_square", "small_square"],
      cost_basis_t: ["per_ton", "per_bale"],
      count_source_t: [
        "satellite_estimated",
        "hand_counted",
        "derived_from_feeding",
      ],
      device_role_t: [
        "trough_level",
        "bunk_level",
        "gate_contact",
        "water_meter",
        "controller",
        "tracker",
      ],
      device_status_t: ["registered", "installed", "live", "retired"],
      farm_status_t: ["setup", "active", "suspended", "archived"],
      feature_kind_t: [
        "pen",
        "alley",
        "feed_lane",
        "hay_stack",
        "building",
        "pasture",
        "water_source",
        "trough",
        "gate",
        "equipment_zone",
      ],
      feature_source_t: [
        "ai_segmented",
        "parcel_import",
        "kml_import",
        "hand_drawn",
      ],
      feed_source_t: ["sensor_derived", "crew_logged", "truck_scale"],
      feed_type_t: ["alfalfa", "grass", "mixed", "straw", "commodity"],
      gate_state_t: ["open", "closed"],
      gateway_model_t: ["UG65", "UG67"],
      head_reason_t: [
        "arrival",
        "birth",
        "death",
        "sale",
        "transfer_in",
        "transfer_out",
        "correction",
      ],
      link_relation_t: ["connects", "contains", "adjacent"],
      member_role_t: ["owner", "manager", "crew", "viewer"],
      order_status_t: [
        "quote",
        "invoiced",
        "paid",
        "shipped",
        "installed",
        "live",
      ],
      org_status_t: ["active", "suspended"],
      raw_status_t: ["pending", "normalized", "dead_letter", "ignored"],
      severity_t: ["info", "warn", "critical"],
      tier_t: ["tier_1", "tier_2", "tier_3"],
      tracker_source_t: ["mdp", "gateway_direct", "lte_webhook"],
      water_method_t: ["pulse_count", "level_drawdown"],
    },
  },
} as const
