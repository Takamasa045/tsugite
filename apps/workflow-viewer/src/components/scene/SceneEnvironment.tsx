import { Grid } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'

interface SceneEnvironmentProps {
  floorY: number
  onBackgroundClick: () => void
  reducedMotion: boolean
}

export function SceneEnvironment({
  floorY,
  onBackgroundClick,
  reducedMotion,
}: SceneEnvironmentProps) {
  return (
    <>
      <color attach="background" args={['#100e0c']} />
      <fog attach="fog" args={['#100e0c', 22, 60]} />
      <ambientLight color="#d7c3a4" intensity={0.46} />
      <directionalLight
        castShadow
        color="#f4dfba"
        intensity={1.5}
        position={[8, 14, 9]}
        shadow-mapSize-height={1024}
        shadow-mapSize-width={1024}
      />
      <pointLight color="#6f9b8d" distance={28} intensity={14} position={[-8, 5, -7]} />
      <pointLight color="#a65d45" distance={24} intensity={10} position={[10, 3, 8]} />
      <Grid
        cellColor="#3a3027"
        cellSize={0.75}
        cellThickness={0.45}
        fadeDistance={45}
        fadeStrength={1.8}
        followCamera={false}
        infiniteGrid
        position={[0, floorY, 0]}
        sectionColor="#8d704f"
        sectionSize={5}
        sectionThickness={0.9}
      />
      <mesh
        position={[0, floorY - 0.04, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation()
          onBackgroundClick()
        }}
      >
        <planeGeometry args={[90, 90]} />
        <meshStandardMaterial
          color="#17110d"
          metalness={0.05}
          opacity={reducedMotion ? 0.5 : 0.66}
          roughness={reducedMotion ? 0.9 : 0.78}
          transparent
        />
      </mesh>
    </>
  )
}
