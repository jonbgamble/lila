import type { LiconValue } from '@/licon';

import type { TreePath } from './tree/types';

export interface QuestionChoice {
  // file://./../../round/src/ctrl.ts
  action: () => void;
  icon?: LiconValue;
  text?: string;
}

export interface QuestionOpts {
  prompt: string; // TODO i18nkey, or just always pretranslate
  yes?: QuestionChoice;
  no?: QuestionChoice;
}

export interface StudyNavigationRequest {
  studyId: string;
  chapterId?: string;
  path?: TreePath;
  orientation?: Color;
  complete?: (error?: Error) => void;
}

export interface StudyOrientationMeta {
  studyId: string;
  chapterId: string;
  orientation: Color;
}
