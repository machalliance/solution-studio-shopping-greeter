export interface ContentParams {
  goal: string
  category: string
  tags?: string[]
  limit: number
}

export interface ContentstackEntry {
  uid: string
  title: string
  url: string
  content_type_uid: string
  summary: string
  tags: string[]
  read_time?: string
  icon: string
  updated_at: string
}

export interface ContentstackResponse {
  entries: ContentstackEntry[]
  count: number
}
