import { Grid } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'

interface SceneEnvironmentProps {
  center: readonly [number, number, number]
  floorY: number
  onBackgroundClick: () => void
  radius: number
  reducedMotion: boolean
}

export function SceneEnvironment({
  center,
  floorY,
  onBackgroundClick,
  radius,
  reducedMotion,
}: SceneEnvironmentProps) {
  const benchLength = Math.max(13, radius * 2 + 5)

  return (
    <>
      <color attach="background" args={['#0c1516']} />
      <fog attach="fog" args={['#0c1516', 26, 58]} />
      <ambientLight color="#dce8e2" intensity={0.72} />
      <directionalLight
        castShadow
        color="#f5e8cf"
        intensity={2.05}
        position={[5, 12, 10]}
        shadow-mapSize-height={1024}
        shadow-mapSize-width={1024}
      />
      <pointLight color="#7fb4a4" distance={34} intensity={20} position={[-7, 5, -5]} />
      <pointLight color="#d39a66" distance={28} intensity={12} position={[10, 4, 7]} />
      <group position={[center[0], floorY, center[2] - 3.6]}>
        {[-benchLength / 2 + 1.1, benchLength / 2 - 1.1].map((offset) => (
          <group key={offset} position={[offset, 2.05, 0]}>
            <mesh castShadow>
              <boxGeometry args={[0.42, 4.1, 0.46]} />
              <meshStandardMaterial color="#4b3528" roughness={0.82} />
            </mesh>
            <mesh position={[offset < 0 ? 0.42 : -0.42, 1.2, 0]} rotation={[0, 0, offset < 0 ? -0.65 : 0.65]}>
              <boxGeometry args={[0.18, 1.5, 0.28]} />
              <meshStandardMaterial color="#765138" roughness={0.78} />
            </mesh>
          </group>
        ))}
        <mesh castShadow position={[0, 4.02, 0]}>
          <boxGeometry args={[benchLength, 0.4, 0.48]} />
          <meshStandardMaterial color="#4b3528" roughness={0.82} />
        </mesh>
        <mesh position={[0, 3.48, 0.02]}>
          <boxGeometry args={[benchLength - 1.25, 0.18, 0.28]} />
          <meshStandardMaterial color="#9a7047" roughness={0.7} />
        </mesh>
        {[-0.2, 0.2].map((offset) => (
          <mesh key={offset} position={[0, 3.76 + offset, 0.255]}>
            <boxGeometry args={[benchLength - 0.7, 0.025, 0.018]} />
            <meshBasicMaterial color="#d8bd91" transparent opacity={0.34} />
          </mesh>
        ))}
      </group>
      <group position={[center[0], floorY + 0.32, center[2]]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[benchLength, 0.26, 2.7]} />
          <meshStandardMaterial color="#5a3d2c" metalness={0.01} roughness={0.78} />
        </mesh>
        <mesh position={[0, 0.15, -1.18]}>
          <boxGeometry args={[benchLength - 0.3, 0.045, 0.09]} />
          <meshStandardMaterial color="#c59a60" metalness={0.04} roughness={0.68} />
        </mesh>
        <mesh position={[0, 0.15, 1.18]}>
          <boxGeometry args={[benchLength - 0.3, 0.045, 0.09]} />
          <meshStandardMaterial color="#416a62" metalness={0.03} roughness={0.65} />
        </mesh>
        {[-0.36, 0.36].map((offset) => (
          <mesh key={offset} position={[0, 0.145, offset]}>
            <boxGeometry args={[benchLength - 0.8, 0.025, 0.018]} />
            <meshBasicMaterial color="#d7bc87" transparent opacity={0.36} />
          </mesh>
        ))}
        {[-benchLength / 2 + 1.1, 0, benchLength / 2 - 1.1].map((offset) => (
          <group key={offset} position={[offset, -0.37, 0]}>
            <mesh castShadow>
              <boxGeometry args={[0.32, 0.58, 2.22]} />
              <meshStandardMaterial color="#3f2b22" roughness={0.84} />
            </mesh>
            <mesh position={[0, -0.18, 0]}>
              <boxGeometry args={[0.58, 0.16, 2.5]} />
              <meshStandardMaterial color="#715039" roughness={0.8} />
            </mesh>
          </group>
        ))}
      </group>
      <Grid
        cellColor="#20302e"
        cellSize={0.75}
        cellThickness={0.45}
        fadeDistance={45}
        fadeStrength={1.8}
        followCamera={false}
        infiniteGrid
        position={[0, floorY, 0]}
        sectionColor="#547a70"
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
          color="#121b19"
          metalness={0.05}
          opacity={reducedMotion ? 0.5 : 0.66}
          roughness={reducedMotion ? 0.9 : 0.78}
          transparent
        />
      </mesh>
    </>
  )
}
