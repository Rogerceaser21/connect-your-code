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
    PostgrestVersion: "12.2.3 (519615d)"
  }
  public: {
    Tables: {
      ais_art_active_theme: {
        Row: {
          active_theme: string
          created_at: string
          id: string
          updated_at: string
        }
        Insert: {
          active_theme?: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Update: {
          active_theme?: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      ais_art_app_config: {
        Row: {
          created_at: string
          id: string
          signup_password: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          signup_password: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          signup_password?: string
          updated_at?: string
        }
        Relationships: []
      }
      ais_art_project_users: {
        Row: {
          created_at: string
          id: string
          password: string
          username: string
        }
        Insert: {
          created_at?: string
          id?: string
          password: string
          username: string
        }
        Update: {
          created_at?: string
          id?: string
          password?: string
          username?: string
        }
        Relationships: []
      }
      ais_att_email_db_parents: {
        Row: {
          access_token_link: string | null
          created_at: string | null
          forename: string
          form: string | null
          id: string
          is_active: boolean | null
          parent_email: string | null
          parent_forename: string | null
          parent_mobile: string | null
          parent_surname: string | null
          relation_type: string | null
          school_id: string
          school_type: string
          surname: string
          updated_at: string | null
          username: string | null
          year_code: string | null
        }
        Insert: {
          access_token_link?: string | null
          created_at?: string | null
          forename: string
          form?: string | null
          id?: string
          is_active?: boolean | null
          parent_email?: string | null
          parent_forename?: string | null
          parent_mobile?: string | null
          parent_surname?: string | null
          relation_type?: string | null
          school_id: string
          school_type: string
          surname: string
          updated_at?: string | null
          username?: string | null
          year_code?: string | null
        }
        Update: {
          access_token_link?: string | null
          created_at?: string | null
          forename?: string
          form?: string | null
          id?: string
          is_active?: boolean | null
          parent_email?: string | null
          parent_forename?: string | null
          parent_mobile?: string | null
          parent_surname?: string | null
          relation_type?: string | null
          school_id?: string
          school_type?: string
          surname?: string
          updated_at?: string | null
          username?: string | null
          year_code?: string | null
        }
        Relationships: []
      }
      ais_att_email_db_students: {
        Row: {
          access_token_link: string | null
          created_at: string | null
          forename: string
          form: string | null
          id: string
          is_active: boolean | null
          pupil_email_address: string | null
          school_id: string
          school_type: string
          surname: string
          updated_at: string | null
          username: string | null
          year_code: string | null
        }
        Insert: {
          access_token_link?: string | null
          created_at?: string | null
          forename: string
          form?: string | null
          id?: string
          is_active?: boolean | null
          pupil_email_address?: string | null
          school_id: string
          school_type: string
          surname: string
          updated_at?: string | null
          username?: string | null
          year_code?: string | null
        }
        Update: {
          access_token_link?: string | null
          created_at?: string | null
          forename?: string
          form?: string | null
          id?: string
          is_active?: boolean | null
          pupil_email_address?: string | null
          school_id?: string
          school_type?: string
          surname?: string
          updated_at?: string | null
          username?: string | null
          year_code?: string | null
        }
        Relationships: []
      }
      ais_attendance_app_user_roles: {
        Row: {
          created_at: string | null
          id: string
          password: string
          role: Database["public"]["Enums"]["ais_attendance_app_role"]
          username: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          password: string
          role?: Database["public"]["Enums"]["ais_attendance_app_role"]
          username: string
        }
        Update: {
          created_at?: string | null
          id?: string
          password?: string
          role?: Database["public"]["Enums"]["ais_attendance_app_role"]
          username?: string
        }
        Relationships: []
      }
      app_configuration: {
        Row: {
          created_at: string | null
          id: string
          settings_password: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          settings_password: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          settings_password?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      art_project_api: {
        Row: {
          api_key: string
          created_at: string | null
          id: string
          key_name: string
          updated_at: string | null
        }
        Insert: {
          api_key: string
          created_at?: string | null
          id?: string
          key_name: string
          updated_at?: string | null
        }
        Update: {
          api_key?: string
          created_at?: string | null
          id?: string
          key_name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      art_project_videos: {
        Row: {
          caption: string | null
          created_at: string
          grade: string
          id: string
          is_hidden: boolean
          is_pinned: boolean
          pin_order: number | null
          prompt: string | null
          student_first_name: string
          student_surname: string
          video_url: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          grade: string
          id?: string
          is_hidden?: boolean
          is_pinned?: boolean
          pin_order?: number | null
          prompt?: string | null
          student_first_name: string
          student_surname: string
          video_url: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          grade?: string
          id?: string
          is_hidden?: boolean
          is_pinned?: boolean
          pin_order?: number | null
          prompt?: string | null
          student_first_name?: string
          student_surname?: string
          video_url?: string
        }
        Relationships: []
      }
      att_app_display_settings: {
        Row: {
          created_at: string
          hide_early_leave_card: boolean
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          hide_early_leave_card?: boolean
          id?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          hide_early_leave_card?: boolean
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      focusos_api_tokens: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          token_hash: string
          token_prefix: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          token_hash: string
          token_prefix: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          token_hash?: string
          token_prefix?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      focusos_google_tokens: {
        Row: {
          access_token: string
          created_at: string
          expires_at: string
          focusos_calendar_id: string | null
          id: string
          refresh_token: string
          scope: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string
          expires_at: string
          focusos_calendar_id?: string | null
          id?: string
          refresh_token: string
          scope: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string
          expires_at?: string
          focusos_calendar_id?: string | null
          id?: string
          refresh_token?: string
          scope?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      focusos_meetings: {
        Row: {
          action_items: Json | null
          created_at: string
          duration_seconds: number | null
          gemini_file_uri: string | null
          gemini_transcribe_attempts: number
          gemini_transcribe_started_at: string | null
          google_calendar_event_id: string | null
          id: string
          participants: Json | null
          processing_error: string | null
          processing_status: string
          project_id: string | null
          recording_gcs_path: string | null
          share_token: string | null
          summary: string | null
          title: string
          transcript_gcs_path: string | null
          transcript_segments: Json | null
          transcription_text: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          action_items?: Json | null
          created_at?: string
          duration_seconds?: number | null
          gemini_file_uri?: string | null
          gemini_transcribe_attempts?: number
          gemini_transcribe_started_at?: string | null
          google_calendar_event_id?: string | null
          id?: string
          participants?: Json | null
          processing_error?: string | null
          processing_status?: string
          project_id?: string | null
          recording_gcs_path?: string | null
          share_token?: string | null
          summary?: string | null
          title?: string
          transcript_gcs_path?: string | null
          transcript_segments?: Json | null
          transcription_text?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          action_items?: Json | null
          created_at?: string
          duration_seconds?: number | null
          gemini_file_uri?: string | null
          gemini_transcribe_attempts?: number
          gemini_transcribe_started_at?: string | null
          google_calendar_event_id?: string | null
          id?: string
          participants?: Json | null
          processing_error?: string | null
          processing_status?: string
          project_id?: string | null
          recording_gcs_path?: string | null
          share_token?: string | null
          summary?: string | null
          title?: string
          transcript_gcs_path?: string | null
          transcript_segments?: Json | null
          transcription_text?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      focusos_profiles: {
        Row: {
          created_at: string
          first_name: string | null
          id: string
          last_name: string | null
          updated_at: string
          user_email: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          updated_at?: string
          user_email?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          updated_at?: string
          user_email?: string | null
          user_id?: string
        }
        Relationships: []
      }
      focusos_project_members: {
        Row: {
          created_at: string
          id: string
          invited_by: string
          invited_email: string
          project_id: string
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_by: string
          invited_email: string
          project_id: string
          role?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_by?: string
          invited_email?: string
          project_id?: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "focusos_project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "focusos_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      focusos_projects: {
        Row: {
          archived_at: string | null
          color: string
          created_at: string
          id: string
          is_shared: boolean
          name: string
          parent_project_id: string | null
          pinned_at: string | null
          sort_order: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          color?: string
          created_at?: string
          id?: string
          is_shared?: boolean
          name: string
          parent_project_id?: string | null
          pinned_at?: string | null
          sort_order?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          color?: string
          created_at?: string
          id?: string
          is_shared?: boolean
          name?: string
          parent_project_id?: string | null
          pinned_at?: string | null
          sort_order?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "focusos_projects_parent_project_id_fkey"
            columns: ["parent_project_id"]
            isOneToOne: false
            referencedRelation: "focusos_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      focusos_recording_sessions: {
        Row: {
          chunk_count: number
          created_at: string
          gcs_folder_path: string
          id: string
          mime_type: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          chunk_count?: number
          created_at?: string
          gcs_folder_path: string
          id?: string
          mime_type?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          chunk_count?: number
          created_at?: string
          gcs_folder_path?: string
          id?: string
          mime_type?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      focusos_shared_items: {
        Row: {
          action_token: string
          completed_at: string | null
          completed_by: string | null
          completion_acknowledged: boolean
          created_at: string
          id: string
          item_id: string
          item_title: string
          item_type: string
          project_name: string | null
          recipient_email: string
          recipient_task_id: string | null
          recipient_user_id: string | null
          sender_acknowledged: boolean | null
          sender_email: string
          sender_name: string | null
          sender_user_id: string
          status: string
          updated_at: string
        }
        Insert: {
          action_token?: string
          completed_at?: string | null
          completed_by?: string | null
          completion_acknowledged?: boolean
          created_at?: string
          id?: string
          item_id: string
          item_title: string
          item_type: string
          project_name?: string | null
          recipient_email: string
          recipient_task_id?: string | null
          recipient_user_id?: string | null
          sender_acknowledged?: boolean | null
          sender_email: string
          sender_name?: string | null
          sender_user_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          action_token?: string
          completed_at?: string | null
          completed_by?: string | null
          completion_acknowledged?: boolean
          created_at?: string
          id?: string
          item_id?: string
          item_title?: string
          item_type?: string
          project_name?: string | null
          recipient_email?: string
          recipient_task_id?: string | null
          recipient_user_id?: string | null
          sender_acknowledged?: boolean | null
          sender_email?: string
          sender_name?: string | null
          sender_user_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      focusos_tasks: {
        Row: {
          assigned_to_email: string | null
          change_request_message: string | null
          completed_at: string | null
          completed_by_email: string | null
          created_at: string
          description: string | null
          due_date: string | null
          end_date: string | null
          google_calendar_event_id: string | null
          id: string
          images: Json | null
          meeting_id: string | null
          priority: string
          project_id: string | null
          share_token: string | null
          sort_order: number | null
          start_date: string | null
          status: string
          timer_is_running: boolean
          timer_start_time: number | null
          timer_total_seconds: number
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_to_email?: string | null
          change_request_message?: string | null
          completed_at?: string | null
          completed_by_email?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          end_date?: string | null
          google_calendar_event_id?: string | null
          id?: string
          images?: Json | null
          meeting_id?: string | null
          priority?: string
          project_id?: string | null
          share_token?: string | null
          sort_order?: number | null
          start_date?: string | null
          status?: string
          timer_is_running?: boolean
          timer_start_time?: number | null
          timer_total_seconds?: number
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_to_email?: string | null
          change_request_message?: string | null
          completed_at?: string | null
          completed_by_email?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          end_date?: string | null
          google_calendar_event_id?: string | null
          id?: string
          images?: Json | null
          meeting_id?: string | null
          priority?: string
          project_id?: string | null
          share_token?: string | null
          sort_order?: number | null
          start_date?: string | null
          status?: string
          timer_is_running?: boolean
          timer_start_time?: number | null
          timer_total_seconds?: number
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "focusos_tasks_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "focusos_meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "focusos_tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "focusos_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      focusos_user_preferences: {
        Row: {
          ai_handoff_default_provider: string | null
          ai_handoff_image_mode: string
          created_at: string | null
          default_display_mode: string
          default_task_card_view: string | null
          default_task_card_view_mobile: string | null
          default_task_filter: string
          default_view: string
          has_completed_home_tour: boolean
          has_completed_meetings_tour: boolean
          has_completed_onboarding: boolean
          has_completed_projects_tour: boolean
          has_completed_task_tour: boolean
          id: string
          notify_due_date: boolean
          notify_timer: boolean
          theme: string
          timer_alert_interval_minutes: number
          updated_at: string | null
          user_id: string
          wallpaper_prefs: Json | null
        }
        Insert: {
          ai_handoff_default_provider?: string | null
          ai_handoff_image_mode?: string
          created_at?: string | null
          default_display_mode?: string
          default_task_card_view?: string | null
          default_task_card_view_mobile?: string | null
          default_task_filter?: string
          default_view?: string
          has_completed_home_tour?: boolean
          has_completed_meetings_tour?: boolean
          has_completed_onboarding?: boolean
          has_completed_projects_tour?: boolean
          has_completed_task_tour?: boolean
          id?: string
          notify_due_date?: boolean
          notify_timer?: boolean
          theme?: string
          timer_alert_interval_minutes?: number
          updated_at?: string | null
          user_id: string
          wallpaper_prefs?: Json | null
        }
        Update: {
          ai_handoff_default_provider?: string | null
          ai_handoff_image_mode?: string
          created_at?: string | null
          default_display_mode?: string
          default_task_card_view?: string | null
          default_task_card_view_mobile?: string | null
          default_task_filter?: string
          default_view?: string
          has_completed_home_tour?: boolean
          has_completed_meetings_tour?: boolean
          has_completed_onboarding?: boolean
          has_completed_projects_tour?: boolean
          has_completed_task_tour?: boolean
          id?: string
          notify_due_date?: boolean
          notify_timer?: boolean
          theme?: string
          timer_alert_interval_minutes?: number
          updated_at?: string | null
          user_id?: string
          wallpaper_prefs?: Json | null
        }
        Relationships: []
      }
      focusos_users: {
        Row: {
          created_at: string
          email: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string | null
          email: string
          first_name: string | null
          id: string
          last_name: string | null
          role: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          first_name?: string | null
          id: string
          last_name?: string | null
          role?: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          role?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      school_databases: {
        Row: {
          created_at: string | null
          data: Json
          description: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string | null
          data: Json
          description?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string | null
          data?: Json
          description?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      sfa_handshakes: {
        Row: {
          created_at: string
          handshake_enc: string
          handshake_hash: string
          school: string
          username: string
        }
        Insert: {
          created_at?: string
          handshake_enc: string
          handshake_hash: string
          school: string
          username: string
        }
        Update: {
          created_at?: string
          handshake_enc?: string
          handshake_hash?: string
          school?: string
          username?: string
        }
        Relationships: []
      }
      sfa_login_attempts: {
        Row: {
          fail_count: number
          last_fail: string | null
          locked_until: string | null
          username: string
        }
        Insert: {
          fail_count?: number
          last_fail?: string | null
          locked_until?: string | null
          username: string
        }
        Update: {
          fail_count?: number
          last_fail?: string | null
          locked_until?: string | null
          username?: string
        }
        Relationships: []
      }
      sfa_subject_dictionary: {
        Row: {
          confirmed: boolean
          label: string
          mnemonic: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          confirmed?: boolean
          label?: string
          mnemonic: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          confirmed?: boolean
          label?: string
          mnemonic?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      student_access_tokens: {
        Row: {
          access_token: string
          created_at: string
          id: string
          school_id: string
          school_type: string
          updated_at: string
        }
        Insert: {
          access_token?: string
          created_at?: string
          id?: string
          school_id: string
          school_type: string
          updated_at?: string
        }
        Update: {
          access_token?: string
          created_at?: string
          id?: string
          school_id?: string
          school_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      student_display_settings: {
        Row: {
          school_id: string
          show_hidden: boolean
          updated_at: string
        }
        Insert: {
          school_id: string
          show_hidden?: boolean
          updated_at?: string
        }
        Update: {
          school_id?: string
          show_hidden?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      studentfeedback_appcredentials: {
        Row: {
          created_at: string
          google_api_key: string | null
          google_sheet_id: string | null
          id: string
          service_account_json: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          google_api_key?: string | null
          google_sheet_id?: string | null
          id?: string
          service_account_json?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          google_api_key?: string | null
          google_sheet_id?: string | null
          id?: string
          service_account_json?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      user_database_access: {
        Row: {
          active_class: string[] | null
          active_grade: string[] | null
          created_at: string | null
          database_id: string
          id: string
          is_active: boolean
          updated_at: string | null
          user_id: string
        }
        Insert: {
          active_class?: string[] | null
          active_grade?: string[] | null
          created_at?: string | null
          database_id: string
          id?: string
          is_active?: boolean
          updated_at?: string | null
          user_id: string
        }
        Update: {
          active_class?: string[] | null
          active_grade?: string[] | null
          created_at?: string | null
          database_id?: string
          id?: string
          is_active?: boolean
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_database_access_database_id_fkey"
            columns: ["database_id"]
            isOneToOne: false
            referencedRelation: "school_databases"
            referencedColumns: ["id"]
          },
        ]
      }
      user_settings: {
        Row: {
          category_presets: string | null
          default_search_method: string | null
          first_name: string | null
          google_cloud_bucket_name: string | null
          google_cloud_project_id: string | null
          google_cloud_service_account_key: string | null
          google_form_entry_key: string | null
          google_form_url: string | null
          google_sheet_url: string | null
          id: string
          last_name: string | null
          name_mappings: string | null
          openai_api_key: string | null
          user_id: string
        }
        Insert: {
          category_presets?: string | null
          default_search_method?: string | null
          first_name?: string | null
          google_cloud_bucket_name?: string | null
          google_cloud_project_id?: string | null
          google_cloud_service_account_key?: string | null
          google_form_entry_key?: string | null
          google_form_url?: string | null
          google_sheet_url?: string | null
          id?: string
          last_name?: string | null
          name_mappings?: string | null
          openai_api_key?: string | null
          user_id: string
        }
        Update: {
          category_presets?: string | null
          default_search_method?: string | null
          first_name?: string | null
          google_cloud_bucket_name?: string | null
          google_cloud_project_id?: string | null
          google_cloud_service_account_key?: string | null
          google_form_entry_key?: string | null
          google_form_url?: string | null
          google_sheet_url?: string | null
          id?: string
          last_name?: string | null
          name_mappings?: string | null
          openai_api_key?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      dreamlit_auth_admin_executor: {
        Args: { command: string }
        Returns: undefined
      }
      focusos_can_access_task_image: {
        Args: { _file_owner_id: string; _user_id: string }
        Returns: boolean
      }
      focusos_get_project_role: {
        Args: { _project_id: string; _user_id: string }
        Returns: string
      }
      focusos_is_project_member: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      get_app_configuration: { Args: never; Returns: Json }
    }
    Enums: {
      ais_attendance_app_role: "admin"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      ais_attendance_app_role: ["admin"],
    },
  },
} as const
