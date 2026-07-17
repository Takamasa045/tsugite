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
  const deckSlats = Array.from({ length: 11 }, (_, index) => index - 5)

  return (
    <>
      <color attach="background" args={['#090e0d']} />
      <fog attach="fog" args={['#090e0d', 25, 56]} />
      <ambientLight color="#eadfca" intensity={0.58} />
      <directionalLight
        castShadow
        color="#ffe8bf"
        intensity={2.35}
        position={[5, 12, 10]}
        shadow-mapSize-height={1024}
        shadow-mapSize-width={1024}
      />
      <pointLight color="#6f9f91" distance={34} intensity={17} position={[-7, 5, -5]} />
      <pointLight color="#d7a05e" distance={28} intensity={15} position={[10, 4, 7]} />
      <group position={[center[0], floorY + 0.035, center[2] + 0.12]}>
        {deckSlats.map((offset) => (
          <mesh key={offset} receiveShadow position={[0, 0, offset * 0.5]}>
            <boxGeometry args={[benchLength + 3.2, 0.07, 0.43]} />
            <meshStandardMaterial
              color={offset % 2 === 0 ? '#30241c' : '#3b2a20'}
              metalness={0.015}
              roughness={0.88}
            />
          </mesh>
        ))}
        {[-2.82, 2.82].map((offset) => (
          <mesh key={offset} position={[0, 0.055, offset]}>
            <boxGeometry args={[benchLength + 3.55, 0.08, 0.11]} />
            <meshStandardMaterial color="#b58a50" metalness={0.12} roughness={0.54} />
          </mesh>
        ))}
        {[-benchLength / 2 - 1.52, benchLength / 2 + 1.52].map((offset) => (
          <mesh castShadow key={offset} position={[offset, 0.16, 0]}>
            <boxGeometry args={[0.18, 0.28, 5.72]} />
            <meshStandardMaterial color="#171512" metalness={0.04} roughness={0.8} />
          </mesh>
        ))}
      </group>
      <group position={[center[0], floorY, center[2] - 3.6]}>
        {[-benchLength / 2 + 1.1, benchLength / 2 - 1.1].map((offset) => (
          <group key={offset} position={[offset, 2.05, 0]}>
            <mesh castShadow>
              <boxGeometry args={[0.42, 4.1, 0.46]} />
              <meshStandardMaterial color="#33261f" roughness={0.88} />
            </mesh>
            <mesh position={[offset < 0 ? 0.42 : -0.42, 1.2, 0]} rotation={[0, 0, offset < 0 ? -0.65 : 0.65]}>
              <boxGeometry args={[0.18, 1.5, 0.28]} />
              <meshStandardMaterial color="#835b37" roughness={0.8} />
            </mesh>
          </group>
        ))}
        <mesh castShadow position={[0, 4.02, 0]}>
          <boxGeometry args={[benchLength, 0.4, 0.48]} />
          <meshStandardMaterial color="#33261f" roughness={0.88} />
        </mesh>
        <mesh position={[0, 3.48, 0.02]}>
          <boxGeometry args={[benchLength - 1.25, 0.18, 0.28]} />
          <meshStandardMaterial color="#ba8b50" roughness={0.64} />
        </mesh>
        {[-0.2, 0.2].map((offset) => (
          <mesh key={offset} position={[0, 3.76 + offset, 0.255]}>
            <boxGeometry args={[benchLength - 0.7, 0.025, 0.018]} />
            <meshBasicMaterial color="#e4c486" transparent opacity={0.44} />
          </mesh>
        ))}
      </group>
      <group position={[center[0], floorY + 0.32, center[2]]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[benchLength, 0.26, 2.7]} />
          <meshStandardMaterial color="#5f3e28" metalness={0.015} roughness={0.8} />
        </mesh>
        <mesh position={[0, 0.15, -1.18]}>
          <boxGeometry args={[benchLength - 0.3, 0.045, 0.09]} />
          <meshStandardMaterial color="#d0a75f" metalness={0.12} roughness={0.54} />
        </mesh>
        <mesh position={[0, 0.15, 1.18]}>
          <boxGeometry args={[benchLength - 0.3, 0.045, 0.09]} />
          <meshStandardMaterial color="#3f7468" metalness={0.08} roughness={0.58} />
        </mesh>
        {[-0.36, 0.36].map((offset) => (
          <mesh key={offset} position={[0, 0.145, offset]}>
            <boxGeometry args={[benchLength - 0.8, 0.025, 0.018]} />
            <meshBasicMaterial color="#ead19a" transparent opacity={0.42} />
          </mesh>
        ))}
        {[-benchLength / 2 + 1.1, 0, benchLength / 2 - 1.1].map((offset) => (
          <group key={offset} position={[offset, -0.37, 0]}>
            <mesh castShadow>
              <boxGeometry args={[0.32, 0.58, 2.22]} />
              <meshStandardMaterial color="#2f221c" roughness={0.88} />
            </mesh>
            <mesh position={[0, -0.18, 0]}>
              <boxGeometry args={[0.58, 0.16, 2.5]} />
              <meshStandardMaterial color="#755038" roughness={0.82} />
            </mesh>
          </group>
        ))}
      </group>
      <Grid
        cellColor="#192724"
        cellSize={0.75}
        cellThickness={0.45}
        fadeDistance={45}
        fadeStrength={1.8}
        followCamera={false}
        infiniteGrid
        position={[0, floorY, 0]}
        sectionColor="#42685f"
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
          color="#0f1715"
          metalness={0.05}
          opacity={reducedMotion ? 0.5 : 0.66}
          roughness={reducedMotion ? 0.9 : 0.78}
          transparent
        />
      </mesh>
    </>
  )
}
