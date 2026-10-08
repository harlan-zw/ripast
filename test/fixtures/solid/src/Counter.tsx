import { createSignal, For, Show } from 'solid-js'

export interface CounterProps {
  initial: number
  labels: string[]
}

export function Counter(props: CounterProps) {
  const [count, setCount] = createSignal(props.initial)
  return (
    <section class="bg-gray-500 text-white" classList={{ 'text-gray-900': count() > 0 }}>
      <button onClick={() => setCount(value => value + 1)}>{count()}</button>
      <Show when={count() > 0} fallback={<span>Empty</span>}>
        <For each={props.labels}>{label => <span>{label}: {count()}</span>}</For>
      </Show>
    </section>
  )
}
