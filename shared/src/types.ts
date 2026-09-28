export type Elem = 'brasa' | 'mare' | 'broto';
export const ELEMS: readonly Elem[] = ['brasa', 'mare', 'broto'];

export type Hybrid = 'vapor' | 'cinza' | 'mangue';
export type Form = Elem | Hybrid | 'quimera' | 'neutro';
export const FORMS: readonly Form[] = ['neutro', 'brasa', 'mare', 'broto', 'vapor', 'cinza', 'mangue', 'quimera'];

/** Níveis 1 a 4: 0 bebê (acabou de sair do ovo), 1 filhote, 2 adulto, 3 forma final */
export type Stage = 0 | 1 | 2 | 3;
export const MAX_STAGE: Stage = 3;

export type BasicAction = 'ataque' | 'defesa' | 'carga';
export const BASIC_ACTIONS: readonly BasicAction[] = ['ataque', 'defesa', 'carga'];
/** 'especial' usa o Especial da build (Golpe Brutal, Explosão Arcana ou Armadilha). */
export type Action = BasicAction | 'especial';
export const ACTIONS: readonly Action[] = ['ataque', 'defesa', 'carga', 'especial'];

export type Phase = 'coleta' | 'cacada' | 'final' | 'duelo' | 'fim';

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
