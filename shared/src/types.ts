export type Elem = 'brasa' | 'mare' | 'broto';
export const ELEMS: readonly Elem[] = ['brasa', 'mare', 'broto'];

export type Hybrid = 'vapor' | 'cinza' | 'mangue';
export type Form = Elem | Hybrid | 'quimera' | 'neutro';
export const FORMS: readonly Form[] = ['neutro', 'brasa', 'mare', 'broto', 'vapor', 'cinza', 'mangue', 'quimera'];

/** 0 ovo, 1 filhote, 2 adulto, 3 forma final */
export type Stage = 0 | 1 | 2 | 3;
export const MAX_STAGE: Stage = 3;

export type Action = 'ataque' | 'defesa' | 'carga';
export const ACTIONS: readonly Action[] = ['ataque', 'defesa', 'carga'];

export type Phase = 'coleta' | 'cacada' | 'final' | 'subita' | 'fim';

export type TypePoints = Record<Elem, number>;

export const emptyPoints = (): TypePoints => ({ brasa: 0, mare: 0, broto: 0 });

/** Resumo visual de um bicho: tudo que o cliente precisa para desenhá-lo. */
export interface Look {
  form: Form;
  stage: Stage;
  /** Elementos em ordem de dominância (maior primeiro), só os que têm pontos. */
  order: Elem[];
}

export interface Vec {
  x: number;
  y: number;
}
